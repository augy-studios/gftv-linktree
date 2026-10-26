// An in-memory stand-in for the supabase-js client, covering the query
// builder calls the API makes, with the schema's unique constraints, foreign
// key cascades and RPC functions from migrations/001 to 013. Enough to drive every
// route end to end in tests; not a general PostgREST.

import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();

// created_at for an insert: never the same twice, so "newest first" has one
// answer even when a test inserts two rows in the same millisecond, as
// Postgres's microsecond timestamps all but always do.
let lastStamp = 0;
const stamp = () => {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
};

const DEFAULTS = {
  gftvonelink_pages: () => ({ display_name: '', bio: '', avatar_path: null, totp_secret: null, telegram_chat_id: null, telegram_username: null, status: 'pending', ban_reason: null, banned_at: null, banned_by: null, password_changed_at: now(), activated_at: null, updated_at: now(), redirect_url: null, last_sign_in_at: now(), dormancy_warned_at: null, needs_review: false, reviewed_at: null, reviewed_by: null, quarantined_at: null, quarantine_reason: null, links_cap: null }),
  gftvonelink_links: () => ({ order_index: 0, icon: 'link', click_count: 0, is_active: true, removed_at: null, removed_by: null, removed_reason: null, updated_at: now() }),
  gftvonelink_passkeys: () => ({ counter: 0, transports: null, label: null, last_used_at: null }),
  gftvonelink_staff_passkeys: () => ({ counter: 0, transports: null, label: null, last_used_at: null }),
  gftvonelink_recovery_codes: () => ({ used: false, used_at: null }),
  gftvonelink_sessions: () => ({ last_seen_at: now() }),
  gftvonelink_auth_challenges: () => ({ attempts: 0, pending_totp_secret: null, telegram_code_hash: null, telegram_code_expires_at: null }),
  gftvonelink_telegram_links: () => ({ used_at: null }),
  gftvonelink_reports: () => ({ link_id: null, details: '', status: 'open', resolved_by: null, resolved_at: null, resolution_note: null }),
  gftvonelink_audit_logs: () => ({ details: {}, actor_type: 'system', actor_id: null, page_id: null, ip_hash: null, visitor_hash: null }),
  gftvonelink_blocked_patterns: () => ({ applies_to: 'links', reason: null }),
  gftvonelink_review_patterns: () => ({ reason: null }),
  gftvonelink_link_cap_requests: () => ({ status: 'pending', granted_cap: null, review_note: null, reviewed_by: null, reviewed_at: null }),
  gftvonelink_testimonials: () => ({ page_slug: null, is_visible: true, order_index: 0, updated_at: now(), page_id: null, status: 'approved', consented_at: null, reviewed_by: null, reviewed_at: null }),
};

// A list for a primary key over several columns.
const PRIMARY = { gftvonelink_blocked_slugs: 'slug', gftvonelink_blocked_domains: 'domain', gftvonelink_rate_limits: 'bucket', gftvonelink_ip_bans: 'ip_hash', gftvonelink_visitor_bans: ['visitor_hash', 'ip_hash'], gftvonelink_settings: 'key' };
const UNIQUE = {
  gftvonelink_pages: ['slug'],
  gftvonelink_passkeys: ['credential_id'],
  gftvonelink_staff_passkeys: ['credential_id'],
  gftvonelink_sessions: ['token_hash'],
  gftvonelink_staff_sessions: ['token_hash'],
  gftvonelink_auth_challenges: ['token_hash'],
  gftvonelink_telegram_links: ['token_hash'],
  gftvhello_users: ['username', 'email'],
  gftvonelink_blocked_patterns: ['pattern'],
  gftvonelink_review_patterns: ['pattern'],
  gftvonelink_testimonials: ['page_id'],
};

// Unique indexes with a where clause: one open link limit request per page.
const PARTIAL_UNIQUE = {
  gftvonelink_link_cap_requests: [{ column: 'page_id', where: (r) => r.status === 'pending' }],
};

// The link limit trigger from migration 013: the page's own limit, else the
// links_cap setting, else 20; removed links do not count.
function overLinkCap(table, row) {
  const page = table('gftvonelink_pages').find((p) => p.id === row.page_id);
  const setting = table('gftvonelink_settings').find((r) => r.key === 'links_cap');
  const cap = page?.links_cap ?? (typeof setting?.value === 'number' ? setting.value : null) ?? 20;
  const used = table('gftvonelink_links').filter((l) => l.page_id === row.page_id && !l.removed_at).length;
  return used >= cap;
}

// child table -> [{ column, parent, onDelete }]
const FKS = {
  gftvonelink_links: [{ column: 'page_id', parent: 'gftvonelink_pages', onDelete: 'cascade' }],
  gftvonelink_passkeys: [{ column: 'page_id', parent: 'gftvonelink_pages', onDelete: 'cascade' }],
  gftvonelink_recovery_codes: [{ column: 'page_id', parent: 'gftvonelink_pages', onDelete: 'cascade' }],
  gftvonelink_sessions: [{ column: 'page_id', parent: 'gftvonelink_pages', onDelete: 'cascade' }],
  gftvonelink_telegram_links: [{ column: 'page_id', parent: 'gftvonelink_pages', onDelete: 'cascade' }],
  gftvonelink_page_stats: [{ column: 'page_id', parent: 'gftvonelink_pages', onDelete: 'cascade' }],
  gftvonelink_testimonials: [{ column: 'page_id', parent: 'gftvonelink_pages', onDelete: 'cascade' }],
  gftvonelink_link_cap_requests: [{ column: 'page_id', parent: 'gftvonelink_pages', onDelete: 'cascade' }],
  gftvonelink_reports: [
    { column: 'page_id', parent: 'gftvonelink_pages', onDelete: 'cascade' },
    { column: 'link_id', parent: 'gftvonelink_links', onDelete: 'set null' },
  ],
  gftvonelink_staff_sessions: [{ column: 'staff_user_id', parent: 'gftvhello_users', onDelete: 'cascade' }],
  gftvonelink_staff_passkeys: [{ column: 'staff_user_id', parent: 'gftvhello_users', onDelete: 'cascade' }],
  gftvhello_backup_codes: [{ column: 'user_id', parent: 'gftvhello_users', onDelete: 'cascade' }],
};

function splitTop(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function likeToRegex(pattern, flags) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, flags);
}

export function createFakeDb() {
  const tables = {};
  const table = (name) => (tables[name] ??= []);

  function project(name, row, select) {
    if (!select || select.trim() === '*') return { ...row };
    const out = {};
    for (const part of splitTop(select.replace(/\s+/g, ' '))) {
      const embed = part.match(/^(?:(\w+):)?(\w+)\s*\((.*)\)$/);
      if (embed) {
        const [, alias, target, inner] = embed;
        const key = alias || target;
        const up = (FKS[name] || []).find((fk) => fk.parent === target);
        if (up) {
          const parent = table(target).find((r) => r.id === row[up.column]);
          out[key] = parent ? project(target, parent, inner) : null;
        } else {
          const down = (FKS[target] || []).find((fk) => fk.parent === name);
          const children = down ? table(target).filter((r) => r[down.column] === row.id) : [];
          out[key] = inner.trim() === 'count' ? [{ count: children.length }] : children.map((c) => project(target, c, inner));
        }
      } else {
        out[part] = row[part] === undefined ? null : row[part];
      }
    }
    return out;
  }

  function cascade(name, removed) {
    for (const [child, fks] of Object.entries(FKS)) {
      for (const fk of fks) {
        if (fk.parent !== name) continue;
        const ids = new Set(removed.map((r) => r.id));
        if (fk.onDelete === 'cascade') {
          const gone = table(child).filter((r) => ids.has(r[fk.column]));
          tables[child] = table(child).filter((r) => !ids.has(r[fk.column]));
          cascade(child, gone);
        } else {
          for (const r of table(child)) if (ids.has(r[fk.column])) r[fk.column] = null;
        }
      }
    }
  }

  function violates(name, row, ignore) {
    for (const col of UNIQUE[name] || []) {
      if (row[col] === undefined || row[col] === null) continue;
      if (table(name).some((r) => r !== ignore && r[col] === row[col])) return true;
    }
    for (const { column, where } of PARTIAL_UNIQUE[name] || []) {
      if (!where(row)) continue;
      if (table(name).some((r) => r !== ignore && where(r) && r[column] === row[column])) return true;
    }
    return false;
  }

  class Query {
    constructor(name) {
      this.name = name;
      this.filters = [];
      this.op = 'select';
      this.columns = '*';
      this.wantRows = true;
    }
    select(columns = '*', opts = {}) {
      if (this.op === 'select') {
        this.columns = columns;
        this.countMode = opts.count;
        this.head = opts.head;
      } else {
        this.returning = columns;
      }
      return this;
    }
    insert(values) { this.op = 'insert'; this.values = values; return this; }
    upsert(values) { this.op = 'upsert'; this.values = values; return this; }
    update(fields) { this.op = 'update'; this.fields = fields; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
    lt(c, v) { this.filters.push((r) => r[c] !== null && r[c] < v); return this; }
    gt(c, v) { this.filters.push((r) => r[c] !== null && r[c] > v); return this; }
    gte(c, v) { this.filters.push((r) => r[c] !== null && r[c] >= v); return this; }
    is(c, v) { this.filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return this; }
    not(c, op, v) {
      if (op !== 'is' || v !== null) throw new Error(`fake not(${op}) unsupported`);
      this.filters.push((r) => r[c] !== null && r[c] !== undefined);
      return this;
    }
    in(c, values) { this.filters.push((r) => values.includes(r[c])); return this; }
    like(c, p) { const re = likeToRegex(p, ''); this.filters.push((r) => re.test(String(r[c] ?? ''))); return this; }
    ilike(c, p) { const re = likeToRegex(p, 'i'); this.filters.push((r) => re.test(String(r[c] ?? ''))); return this; }
    or(expr) {
      const clauses = expr.split(/,(?=\w+\.)/).map((part) => {
        const m = part.match(/^(\w+)\.(ilike|eq)\.(?:"(.*)"|(.*))$/);
        if (!m) throw new Error(`fake or() cannot parse ${part}`);
        const value = m[3] ?? m[4];
        const re = m[2] === 'ilike' ? likeToRegex(value, 'i') : null;
        return (r) => (re ? re.test(String(r[m[1]] ?? '')) : String(r[m[1]]) === value);
      });
      this.filters.push((r) => clauses.some((f) => f(r)));
      return this;
    }
    order(c, { ascending = true } = {}) { this.sort = { c, ascending }; return this; }
    range(from, to) { this.window = [from, to]; return this; }
    limit(n) { this.window = [0, n - 1]; return this; }
    maybeSingle() { this.single_ = 'maybe'; return this; }
    single() { this.single_ = 'one'; return this; }
    then(resolve, reject) {
      try { resolve(this.run()); } catch (e) { reject(e); }
    }
    matches() { return table(this.name).filter((r) => this.filters.every((f) => f(r))); }
    shape(rows, columns) {
      let out = rows.map((r) => project(this.name, r, columns));
      if (this.single_ === 'one') {
        if (out.length !== 1) return { data: null, error: { code: 'PGRST116', message: `expected one row, got ${out.length}` } };
        return { data: out[0], error: null };
      }
      if (this.single_ === 'maybe') {
        if (out.length > 1) return { data: null, error: { code: 'PGRST116', message: 'more than one row' } };
        return { data: out[0] ?? null, error: null };
      }
      return { data: out, error: null };
    }
    run() {
      const name = this.name;
      if (this.op === 'select') {
        let rows = this.matches();
        if (this.sort) {
          const { c, ascending } = this.sort;
          rows = [...rows].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (ascending ? 1 : -1));
        }
        const count = rows.length;
        if (this.window) rows = rows.slice(this.window[0], this.window[1] + 1);
        if (this.head) return { data: null, error: null, count };
        return { ...this.shape(rows, this.columns), count: this.countMode ? count : null };
      }
      if (this.op === 'insert' || this.op === 'upsert') {
        const list = Array.isArray(this.values) ? this.values : [this.values];
        const made = [];
        for (const values of list) {
          const pk = PRIMARY[name] || 'id';
          if (this.op === 'upsert') {
            const existing = table(name).find((r) => [].concat(pk).every((c) => r[c] === values[c]));
            if (existing) { Object.assign(existing, values); made.push(existing); continue; }
          }
          const row = { ...(DEFAULTS[name]?.() ?? {}), created_at: stamp(), ...values };
          if (pk === 'id' && !row.id) row.id = randomUUID();
          for (const fk of FKS[name] || []) {
            if (row[fk.column] && !table(fk.parent).some((p) => p.id === row[fk.column])) {
              return { data: null, error: { code: '23503', message: `fk ${fk.column}` } };
            }
          }
          if (violates(name, row)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          if (name === 'gftvonelink_links' && overLinkCap(table, row)) return { data: null, error: { code: 'P0001', message: 'too_many_links' } };
          table(name).push(row);
          made.push(row);
        }
        if (this.returning === undefined) return { data: null, error: null };
        return this.shape(made, this.returning);
      }
      if (this.op === 'update') {
        const rows = this.matches();
        for (const r of rows) {
          const next = { ...r, ...this.fields };
          if (violates(name, next, r)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          Object.assign(r, this.fields);
          if ('updated_at' in r) r.updated_at = now();
        }
        if (this.returning === undefined) return { data: null, error: null };
        return this.shape(rows, this.returning);
      }
      if (this.op === 'delete') {
        const rows = this.matches();
        tables[name] = table(name).filter((r) => !rows.includes(r));
        cascade(name, rows);
        if (this.returning === undefined) return { data: null, error: null };
        return this.shape(rows, this.returning);
      }
      throw new Error(`fake op ${this.op}`);
    }
  }

  // One running count per page, Singapore day, kind and key (migration 003).
  function statHit(pageId, kind, key) {
    const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
    const t = table('gftvonelink_page_stats');
    const row = t.find((r) => r.page_id === pageId && r.day === day && r.kind === kind && r.key === key);
    if (row) row.hits += 1;
    else t.push({ page_id: pageId, day, kind, key, hits: 1 });
  }

  const rpcs = {
    gftvonelink_rate_hit({ p_bucket, p_window_seconds }) {
      const t = table('gftvonelink_rate_limits');
      let row = t.find((r) => r.bucket === p_bucket);
      const windowStart = Date.now() - p_window_seconds * 1000;
      if (!row) {
        row = { bucket: p_bucket, hits: 0, window_start: now() };
        t.push(row);
      }
      if (new Date(row.window_start).getTime() < windowStart) {
        row.hits = 0;
        row.window_start = now();
      }
      row.hits += 1;
      return row.hits;
    },
    gftvonelink_link_click({ p_link_id }) {
      const link = table('gftvonelink_links').find((l) => l.id === p_link_id);
      const page = link && table('gftvonelink_pages').find((p) => p.id === link.page_id);
      if (!link || !page || page.status !== 'active' || !link.is_active || link.removed_at) return false;
      link.click_count += 1;
      statHit(page.id, 'clicks', '');
      return true;
    },
    gftvonelink_page_visit({ p_page_id, p_country, p_device, p_referrer }) {
      const page = table('gftvonelink_pages').find((p) => p.id === p_page_id);
      if (!page || page.status !== 'active') return false;
      statHit(page.id, 'visits', '');
      statHit(page.id, 'country', p_country ?? 'XX');
      statHit(page.id, 'device', p_device ?? 'desktop');
      statHit(page.id, 'referrer', p_referrer ?? '');
      return true;
    },
    // Migration 008. gftvlinks_linkvisits counts only when a test has put rows
    // in it, standing in for "the table exists".
    gftvonelink_site_insights() {
      const stats = table('gftvonelink_page_stats');
      const sgDay = (iso) => new Date(new Date(iso).getTime() + 8 * 3600_000).toISOString().slice(0, 10);
      const sum = (kind, key) => stats.filter((r) => r.kind === kind && (key === undefined || r.key === key)).reduce((n, r) => n + r.hits, 0);
      const visits = table('gftvlinks_linkvisits');
      const today = sgDay(new Date().toISOString());
      const daily = Array.from({ length: 30 }, (_, i) => {
        const day = sgDay(new Date(Date.parse(`${today}T12:00:00Z`) - (29 - i) * 86400_000).toISOString());
        return { day, clicks: stats.filter((r) => r.kind === 'clicks' && r.day === day).reduce((n, r) => n + r.hits, 0) + visits.filter((v) => sgDay(v.visited_at) === day).length };
      });
      const devices = {};
      for (const r of stats.filter((s) => s.kind === 'device')) devices[r.key] = (devices[r.key] || 0) + r.hits;
      for (const v of visits) devices[v.device_type.toLowerCase()] = (devices[v.device_type.toLowerCase()] || 0) + 1;
      const top = (kind, skip) => {
        const totals = new Map();
        for (const r of stats.filter((s) => s.kind === kind && s.key !== skip)) totals.set(r.key, (totals.get(r.key) || 0) + r.hits);
        const [key, hits] = [...totals].sort((a, b) => b[1] - a[1])[0] ?? [];
        return key === undefined ? null : { key, hits };
      };
      return {
        visits: sum('visits'),
        clicks: sum('clicks') + visits.length,
        pages: table('gftvonelink_pages').filter((p) => p.status === 'active').length,
        daily,
        devices,
        country: top('country', 'XX'),
        referrer: top('referrer', ''),
      };
    },
    gftvonelink_reorder_links({ p_page_id, p_ids }) {
      p_ids.forEach((id, i) => {
        const link = table('gftvonelink_links').find((l) => l.id === id && l.page_id === p_page_id);
        if (link) link.order_index = i;
      });
      return null;
    },
  };

  // Supabase Storage: upload and remove, kept in a map of "bucket/path".
  const objects = new Map();
  const storage = {
    from: (bucket) => ({
      async upload(path, body, opts = {}) {
        const key = `${bucket}/${path}`;
        if (objects.has(key) && !opts.upsert) return { data: null, error: { message: 'The resource already exists' } };
        objects.set(key, { body, contentType: opts.contentType });
        return { data: { path }, error: null };
      },
      async remove(paths) {
        paths.forEach((p) => objects.delete(`${bucket}/${p}`));
        return { data: paths.map((name) => ({ name })), error: null };
      },
      async download(path) {
        const object = objects.get(`${bucket}/${path}`);
        if (!object) return { data: null, error: { message: 'Object not found' } };
        return { data: new Blob([object.body], { type: object.contentType }), error: null };
      },
    }),
  };

  return {
    tables,
    table,
    objects,
    storage,
    from: (name) => new Query(name),
    rpc: async (name, args) => {
      if (!rpcs[name]) return { data: null, error: { message: `no rpc ${name}` } };
      return { data: rpcs[name](args), error: null };
    },
  };
}
