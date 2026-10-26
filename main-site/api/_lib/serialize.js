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
  return (links ?? [])
    .filter((l) => l.is_active && !l.removed_at)
    .filter((l) => !addressBlocked(l.url, blocked))
    .sort((a, b) => a.order_index - b.order_index)
    .map(publicLink);
}

// redirectUrl is set when the page sends visitors on to one address rather
// than listing links. A redirect the block lists now catch is dropped, and
// the page falls back to its links.
export function publicPage(page, links, blocked) {
  const redirect = page.redirect_url && !addressBlocked(page.redirect_url, blocked) ? page.redirect_url : null;
  return {
    slug: page.slug,
    displayName: page.display_name || page.slug,
    bio: page.bio,
    avatarUrl: avatarUrl(page.avatar_path),
    redirectUrl: redirect,
    links: servableLinks(links, blocked),
  };
}

// The owner's view of their own link: everything they control, plus whether
// staff removed it, but not which staff member did.
export function ownerLink(link) {
  return {
    id: link.id,
    title: link.title,
    url: link.url,
    icon: link.icon,
    isActive: link.is_active,
    clicks: Number(link.click_count) || 0,
    removed: Boolean(link.removed_at),
    removedReason: link.removed_at ? link.removed_reason || null : null,
  };
}

export function ownerPasskey(row) {
  return { id: row.id, label: row.label || null, createdAt: row.created_at, lastUsedAt: row.last_used_at };
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
  if (!row || row.status === 'withdrawn') return null;
  return {
    status: row.status,
    requested: row.requested_cap,
    reason: row.reason,
    granted: row.status === 'approved' || row.status === 'declined' ? row.granted_cap ?? null : null,
    note: row.status === 'pending' ? null : row.review_note || null,
    sentAt: row.created_at,
    reviewedAt: row.reviewed_at || null,
  };
}

// security: { passkeys, backupCodesLeft, telegramReady }, assembled by the caller.
// limits: { linkCap, capRequest }, the same.
export function ownerPage(page, links, security, limits = null) {
  return {
    slug: page.slug,
    displayName: page.display_name,
    bio: page.bio,
    avatarUrl: avatarUrl(page.avatar_path),
    createdAt: page.created_at,
    redirectUrl: page.redirect_url || null,
    // When the page stops being shown unless the owner signs in again.
    lastSignInAt: page.last_sign_in_at || null,
    dormantFrom: page.last_sign_in_at ? dormantFrom(page.last_sign_in_at) : null,
    // The name is on the staff review list and has not been approved yet.
    awaitingReview: Boolean(page.needs_review && !page.reviewed_at),
    // Hidden after repeated attempts at harmful addresses, until staff look.
    quarantined: Boolean(page.quarantined_at),
    links: (links ?? []).sort((a, b) => a.order_index - b.order_index).map(ownerLink),
    linkCap: limits ? limits.linkCap : null,
    linkCapRequest: limits ? limits.capRequest : null,
    security: {
      totp: Boolean(page.totp_secret),
      passkeys: security.passkeys.map(ownerPasskey),
      backupCodesLeft: security.backupCodesLeft,
      // Whether Telegram is linked, and the @handle the owner linked. The
      // numeric chat id stays here.
      telegram: page.telegram_chat_id ? { linked: true, username: page.telegram_username || null } : { linked: false },
      telegramAvailable: security.telegramReady,
    },
  };
}

// ---------------------------------------------------------------------------
// Staff views. Moderation needs the content and its state, not the owner's
// credentials: no second-factor detail beyond yes or no, no chat id.
// ---------------------------------------------------------------------------

export function adminPageRow(page, extra = {}) {
  return {
    id: page.id,
    slug: page.slug,
    displayName: page.display_name,
    bio: page.bio,
    avatarUrl: avatarUrl(page.avatar_path),
    status: page.status,
    banReason: page.ban_reason || null,
    bannedAt: page.banned_at || null,
    createdAt: page.created_at,
    activatedAt: page.activated_at || null,
    telegramLinked: Boolean(page.telegram_chat_id),
    redirectUrl: page.redirect_url || null,
    lastSignInAt: page.last_sign_in_at || null,
    dormant: page.status === 'active' && isDormant(page.last_sign_in_at),
    awaitingReview: Boolean(page.needs_review && !page.reviewed_at),
    quarantined: Boolean(page.quarantined_at),
    quarantineReason: page.quarantine_reason || null,
    ...extra,
  };
}

export function adminLinkRow(link) {
  return {
    id: link.id,
    pageId: link.page_id,
    slug: link.page?.slug ?? null,
    title: link.title,
    url: link.url,
    icon: link.icon,
    isActive: link.is_active,
    clicks: Number(link.click_count) || 0,
    removedAt: link.removed_at || null,
    removedReason: link.removed_reason || null,
    createdAt: link.created_at,
  };
}

export function adminReportRow(report) {
  return {
    id: report.id,
    pageId: report.page_id,
    slug: report.page?.slug ?? null,
    pageStatus: report.page?.status ?? null,
    link: report.link ? { id: report.link.id, title: report.link.title, url: report.link.url, removed: Boolean(report.link.removed_at) } : null,
    reason: report.reason,
    details: report.details,
    status: report.status,
    resolutionNote: report.resolution_note || null,
    resolvedAt: report.resolved_at || null,
    createdAt: report.created_at,
  };
}

export function adminAuditRow(row) {
  return {
    id: row.id,
    action: row.action,
    actorType: row.actor_type,
    actorId: row.actor_id,
    pageId: row.page_id,
    details: row.details ?? {},
    createdAt: row.created_at,
  };
}

export function adminTestimonialRow(row) {
  return {
    id: row.id,
    quote: row.quote,
    author: row.author,
    pageSlug: row.page_slug || null,
    isVisible: row.is_visible,
    // pending | approved | declined; sent in by the page's owner, or entered by staff.
    status: row.status || 'approved',
    sentByOwner: Boolean(row.page_id),
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || null,
  };
}

// A request for more links, for staff. used and limit are the page's now,
// not when it asked.
export function adminCapRequestRow(row, { used, limit } = {}) {
  return {
    id: row.id,
    pageId: row.page_id,
    slug: row.page?.slug ?? null,
    displayName: row.page?.display_name || null,
    status: row.status,
    requested: row.requested_cap,
    capWhenAsked: row.current_cap,
    used: used ?? null,
    limit: limit ?? null,
    reason: row.reason,
    granted: row.granted_cap ?? null,
    note: row.review_note || null,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at || null,
  };
}

// A page with a limit of its own, for admins only.
export function adminCapPageRow(page, used) {
  return { id: page.id, slug: page.slug, displayName: page.display_name || null, limit: page.links_cap, used };
}

// The owner's own testimonial, or null.
export function ownerTestimonial(row) {
  if (!row) return null;
  return { quote: row.quote, status: row.status, sentAt: row.created_at, reviewedAt: row.reviewed_at || null };
}

// ---------------------------------------------------------------------------
// The home page
// ---------------------------------------------------------------------------

export function publicTestimonial(row) {
  return { id: row.id, quote: row.quote, author: row.author, pageSlug: row.page_slug || null };
}
