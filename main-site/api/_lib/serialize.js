// What leaves the server, decided field by field.
//
// No route sends a database row as it came back. Each audience gets an object
// built here from an explicit list, so a column added to a table later is
// never published by accident. Secrets (password_hash, totp_secret, code
// hashes, token hashes), Telegram chat ids, staff emails and reporter hashes
// have no serializer at all and so cannot reach a browser.

import { addressBlocked, dormantFrom, isDormant } from './validate.js';
import { avatarUrl } from './avatar.js';

// A visitor's view of a link. Hidden, removed and blocked links never get
// this far.
export function publicLink(link) {
  return { id: link.id, title: link.title, url: link.url, icon: link.icon };
}

// Only links that are switched on, not removed by staff, and not caught by
// the staff block lists ({ domains, patterns }), in the owner's order.
export function servableLinks(links, blocked) {
  let list = [];
  if (links !== null && links !== undefined) {
    list = links;
  }
  return list
    .filter((link) => {
      if (link.is_active && !link.removed_at) {
        return true;
      }
      return false;
    })
    .filter((link) => !addressBlocked(link.url, blocked))
    .sort((left, right) => left.order_index - right.order_index)
    .map(publicLink);
}

// redirectUrl is set when the page sends visitors on to one address rather
// than listing links. A redirect the block lists now catch is dropped, and
// the page falls back to its links.
export function publicPage(page, links, blocked) {
  let redirect = null;
  if (page.redirect_url && !addressBlocked(page.redirect_url, blocked)) {
    redirect = page.redirect_url;
  }
  let displayName = page.slug;
  if (page.display_name) {
    displayName = page.display_name;
  }
  return {
    slug: page.slug,
    displayName,
    bio: page.bio,
    avatarUrl: avatarUrl(page.avatar_path),
    redirectUrl: redirect,
    links: servableLinks(links, blocked),
    // On the GFTV team, as an admin has confirmed (migration 015). Only the
    // date and the optional role go out; which admin did it stays here.
    team: publicTeam(page),
  };
}

// One entry on the public /team list.
export function publicTeamMember(page) {
  let displayName = page.slug;
  if (page.display_name) {
    displayName = page.display_name;
  }
  let role = null;
  if (page.team_role) {
    role = page.team_role;
  }
  return {
    slug: page.slug,
    displayName,
    avatarUrl: avatarUrl(page.avatar_path),
    role,
    verifiedAt: page.team_verified_at,
  };
}

export function publicTeam(page) {
  if (!page.team_verified_at) {
    return null;
  }
  let role = null;
  if (page.team_role) {
    role = page.team_role;
  }
  return { verifiedAt: page.team_verified_at, role };
}

// The owner's view of their own link: everything they control, plus whether
// staff removed it, but not which staff member did.
export function ownerLink(link) {
  let clicks = Number(link.click_count);
  if (!clicks) {
    clicks = 0;
  }
  // Staff's reason goes out only while the link is removed.
  let removedReason = null;
  if (link.removed_at && link.removed_reason) {
    removedReason = link.removed_reason;
  }
  return {
    id: link.id,
    title: link.title,
    url: link.url,
    icon: link.icon,
    isActive: link.is_active,
    clicks,
    removed: Boolean(link.removed_at),
    removedReason,
  };
}

export function ownerPasskey(row) {
  let label = null;
  if (row.label) {
    label = row.label;
  }
  return { id: row.id, label, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

// How many links the owner has used of their limit. custom: an admin gave
// this page its own limit, rather than the default.
export function ownerLinkCap(cap, used) {
  return { used, limit: cap.limit, custom: cap.override !== null };
}

// The owner's latest request for more links, or null. A withdrawn one is as
// good as none. granted is the limit it was given: on an approval, or on a
// decline that came with a smaller raise. The note is what the reviewer
// wrote back; who reviewed it stays here.
export function ownerCapRequest(row) {
  if (!row || row.status === 'withdrawn') {
    return null;
  }
  let granted = null;
  if (row.status === 'approved' || row.status === 'declined') {
    if (row.granted_cap !== null && row.granted_cap !== undefined) {
      granted = row.granted_cap;
    }
  }
  // A pending request has no note yet.
  let note = null;
  if (row.status !== 'pending' && row.review_note) {
    note = row.review_note;
  }
  let reviewedAt = null;
  if (row.reviewed_at) {
    reviewedAt = row.reviewed_at;
  }
  return {
    status: row.status,
    requested: row.requested_cap,
    reason: row.reason,
    granted,
    note,
    sentAt: row.created_at,
    reviewedAt,
  };
}

// The owner's editor view of their page: its content, links in order, its
// state (dormancy, review, quarantine, team), its limits and its second
// factors, but never the secrets behind them.
// security: { passkeys, backupCodesLeft, telegramReady }, assembled by the caller.
// limits: { linkCap, capRequest, rename }, the same.
export function ownerPage(page, links, security, limits = null) {
  let redirectUrl = null;
  if (page.redirect_url) {
    redirectUrl = page.redirect_url;
  }
  let lastSignInAt = null;
  if (page.last_sign_in_at) {
    lastSignInAt = page.last_sign_in_at;
  }
  let dormantFromDate = null;
  if (page.last_sign_in_at) {
    dormantFromDate = dormantFrom(page.last_sign_in_at);
  }
  let awaitingReview = false;
  if (page.needs_review && !page.reviewed_at) {
    awaitingReview = true;
  }
  let linkList = [];
  if (links !== null && links !== undefined) {
    linkList = links;
  }
  let linkCap = null;
  let linkCapRequest = null;
  if (limits) {
    linkCap = limits.linkCap;
    linkCapRequest = limits.capRequest;
  }
  let rename = null;
  if (limits !== null && limits !== undefined && limits.rename !== null && limits.rename !== undefined) {
    rename = limits.rename;
  }
  // Whether Telegram is linked, and the @handle the owner linked. The
  // numeric chat id stays here.
  let telegram;
  if (page.telegram_chat_id) {
    let username = null;
    if (page.telegram_username) {
      username = page.telegram_username;
    }
    telegram = { linked: true, username };
  } else {
    telegram = { linked: false };
  }
  return {
    slug: page.slug,
    displayName: page.display_name,
    bio: page.bio,
    avatarUrl: avatarUrl(page.avatar_path),
    createdAt: page.created_at,
    redirectUrl,
    // When the page stops being shown unless the owner signs in again.
    lastSignInAt,
    dormantFrom: dormantFromDate,
    // The name is on the staff review list and has not been approved yet.
    awaitingReview,
    // Hidden after repeated attempts at harmful addresses, until staff look.
    quarantined: Boolean(page.quarantined_at),
    team: publicTeam(page),
    links: linkList.sort((left, right) => left.order_index - right.order_index).map(ownerLink),
    linkCap,
    linkCapRequest,
    // Changing the page name: { available, nextAt, previous } (slug-changes.js).
    rename,
    security: {
      totp: Boolean(page.totp_secret),
      passkeys: security.passkeys.map(ownerPasskey),
      backupCodesLeft: security.backupCodesLeft,
      telegram,
      telegramAvailable: security.telegramReady,
    },
  };
}

// ---------------------------------------------------------------------------
// Staff views. Moderation needs the content and its state, not the owner's
// credentials: no second-factor detail beyond yes or no, no chat id.
// ---------------------------------------------------------------------------

// A page in the staff dashboard's lists: its content and moderation state.
// extra adds fields a route works out itself.
export function adminPageRow(page, extra = {}) {
  let banReason = null;
  if (page.ban_reason) {
    banReason = page.ban_reason;
  }
  let bannedAt = null;
  if (page.banned_at) {
    bannedAt = page.banned_at;
  }
  let activatedAt = null;
  if (page.activated_at) {
    activatedAt = page.activated_at;
  }
  let redirectUrl = null;
  if (page.redirect_url) {
    redirectUrl = page.redirect_url;
  }
  let lastSignInAt = null;
  if (page.last_sign_in_at) {
    lastSignInAt = page.last_sign_in_at;
  }
  // Only a live page can be dormant.
  let dormant = false;
  if (page.status === 'active') {
    dormant = isDormant(page.last_sign_in_at);
  }
  let awaitingReview = false;
  if (page.needs_review && !page.reviewed_at) {
    awaitingReview = true;
  }
  let quarantineReason = null;
  if (page.quarantine_reason) {
    quarantineReason = page.quarantine_reason;
  }
  return {
    id: page.id,
    slug: page.slug,
    displayName: page.display_name,
    bio: page.bio,
    avatarUrl: avatarUrl(page.avatar_path),
    status: page.status,
    banReason,
    bannedAt,
    createdAt: page.created_at,
    activatedAt,
    telegramLinked: Boolean(page.telegram_chat_id),
    redirectUrl,
    lastSignInAt,
    dormant,
    awaitingReview,
    quarantined: Boolean(page.quarantined_at),
    quarantineReason,
    team: publicTeam(page),
    ...extra,
  };
}

// A link in the staff dashboard, with the name of the page it is on.
export function adminLinkRow(link) {
  let slug = null;
  if (link.page !== null && link.page !== undefined && link.page.slug !== null && link.page.slug !== undefined) {
    slug = link.page.slug;
  }
  let clicks = Number(link.click_count);
  if (!clicks) {
    clicks = 0;
  }
  let removedAt = null;
  if (link.removed_at) {
    removedAt = link.removed_at;
  }
  let removedReason = null;
  if (link.removed_reason) {
    removedReason = link.removed_reason;
  }
  return {
    id: link.id,
    slug,
    title: link.title,
    url: link.url,
    icon: link.icon,
    isActive: link.is_active,
    clicks,
    removedAt,
    removedReason,
    createdAt: link.created_at,
  };
}

// A report in the staff dashboard: the page and link it is about, and what
// staff did with it.
export function adminReportRow(report) {
  let slug = null;
  if (report.page !== null && report.page !== undefined && report.page.slug !== null && report.page.slug !== undefined) {
    slug = report.page.slug;
  }
  let pageStatus = null;
  if (report.page !== null && report.page !== undefined && report.page.status !== null && report.page.status !== undefined) {
    pageStatus = report.page.status;
  }
  let link = null;
  if (report.link) {
    link = { title: report.link.title, url: report.link.url, removed: Boolean(report.link.removed_at) };
  }
  let resolutionNote = null;
  if (report.resolution_note) {
    resolutionNote = report.resolution_note;
  }
  let resolvedAt = null;
  if (report.resolved_at) {
    resolvedAt = report.resolved_at;
  }
  return {
    id: report.id,
    pageId: report.page_id,
    slug,
    pageStatus,
    link,
    reason: report.reason,
    details: report.details,
    status: report.status,
    resolutionNote,
    resolvedAt,
    createdAt: report.created_at,
  };
}

export function adminAuditRow(row) {
  let details = {};
  if (row.details !== null && row.details !== undefined) {
    details = row.details;
  }
  return {
    action: row.action,
    actorType: row.actor_type,
    actorId: row.actor_id,
    details,
    createdAt: row.created_at,
  };
}

// A testimonial in the staff dashboard. One with no status counts as
// approved.
export function adminTestimonialRow(row) {
  let pageSlug = null;
  if (row.page_slug) {
    pageSlug = row.page_slug;
  }
  let status = 'approved';
  if (row.status) {
    status = row.status;
  }
  let reviewedAt = null;
  if (row.reviewed_at) {
    reviewedAt = row.reviewed_at;
  }
  return {
    id: row.id,
    quote: row.quote,
    author: row.author,
    pageSlug,
    isVisible: row.is_visible,
    // pending | approved | declined; sent in by the page's owner, or entered by staff.
    status,
    sentByOwner: Boolean(row.page_id),
    createdAt: row.created_at,
    reviewedAt,
  };
}

// A request for more links, for staff. used and limit are the page's now,
// not when it asked.
export function adminCapRequestRow(row, { used, limit } = {}) {
  let slug = null;
  if (row.page !== null && row.page !== undefined && row.page.slug !== null && row.page.slug !== undefined) {
    slug = row.page.slug;
  }
  let displayName = null;
  if (row.page !== null && row.page !== undefined && row.page.display_name) {
    displayName = row.page.display_name;
  }
  let usedNow = null;
  if (used !== null && used !== undefined) {
    usedNow = used;
  }
  let limitNow = null;
  if (limit !== null && limit !== undefined) {
    limitNow = limit;
  }
  let granted = null;
  if (row.granted_cap !== null && row.granted_cap !== undefined) {
    granted = row.granted_cap;
  }
  let note = null;
  if (row.review_note) {
    note = row.review_note;
  }
  let reviewedAt = null;
  if (row.reviewed_at) {
    reviewedAt = row.reviewed_at;
  }
  return {
    id: row.id,
    slug,
    displayName,
    status: row.status,
    requested: row.requested_cap,
    capWhenAsked: row.current_cap,
    used: usedNow,
    limit: limitNow,
    reason: row.reason,
    granted,
    note,
    createdAt: row.created_at,
    reviewedAt,
  };
}

// A page with a limit of its own, for admins only.
export function adminCapPageRow(page, used) {
  let displayName = null;
  if (page.display_name) {
    displayName = page.display_name;
  }
  return { id: page.id, slug: page.slug, displayName, limit: page.links_cap, used };
}

// The owner's own testimonial, or null.
export function ownerTestimonial(row) {
  if (!row) {
    return null;
  }
  let reviewedAt = null;
  if (row.reviewed_at) {
    reviewedAt = row.reviewed_at;
  }
  return { quote: row.quote, status: row.status, sentAt: row.created_at, reviewedAt };
}

// ---------------------------------------------------------------------------
// The home page
// ---------------------------------------------------------------------------

export function publicTestimonial(row) {
  let pageSlug = null;
  if (row.page_slug) {
    pageSlug = row.page_slug;
  }
  return { quote: row.quote, author: row.author, pageSlug };
}
