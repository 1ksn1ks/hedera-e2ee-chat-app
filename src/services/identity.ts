// Who sent a message, and where a typed name points. Same sources and the
// same rules as the Globe map (step_by_step):
//   - profiles: GET /api/user-settings (loadalladata.js), or the four
//     profile topics read directly with the server's extraction rules
//     (server/index.js extractUserSettings) when the relay can't be used;
//   - domains: the domain topic, with loaddomains.js' 28-day ownership chain;
//   - following: GET /api/following (followsuggest.js), or the follow topic
//     replayed for this wallet (server/index.js extractUserFollow);
//   - the topic input takes a domain, a topic id, or a payer id
//     (encryptedtopicchat.js resolveE2eeTopic).
// No runtime imports, so the node tests load this file alone.

export const DEFAULT_AVATAR = 'https://kiloscribe.com/api/inscription-cdn/0.0.4819119';

export const PROFILE_TOPICS = {
  username: '0.0.9609904',
  pic: '0.0.9609881',
  click: '0.0.9752486',
  bio: '0.0.9759201',
} as const;

export type ProfileKind = keyof typeof PROFILE_TOPICS;

export const DOMAIN_TOPIC = '0.0.9606779';
export const FOLLOW_TOPIC = '0.0.10923187';

// One domain purchase adds 28 days (loaddomains.js SECONDS_TO_ADD).
export const DOMAIN_SECONDS = 2419200;

const TOPIC_ID = /^\d+\.\d+\.\d+$/;

export function isTopicId(value: unknown): value is string {
  return typeof value === 'string' && TOPIC_ID.test(value);
}

export interface Profile {
  accountId: string;
  username: string;
  profilePic: string;
  click2url: string;
  bio: string;
  // The topic connected to this account in Edit profile.
  topic: string;
  updatedAt: number;
}

export type ProfileMap = Record<string, Profile>;

// A row in the relay /api/messages shape (the mirror path maps to it too).
export interface TopicRow {
  [key: string]: unknown;
  payer?: string;
  consensus_timestamp?: string | number;
  created?: string;
}

// payerlink.js safeHttpUrl: only http(s) links are opened or painted.
export function safeHttpUrl(raw: unknown): string {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return text;
  } catch {
    return '';
  }
}

export function avatarFor(profile: Profile | null | undefined): string {
  return safeHttpUrl(profile && profile.profilePic) || DEFAULT_AVATAR;
}

// payerUsernameNode prints a name on one line.
export function displayName(profile: Profile | null | undefined): string {
  const name = profile && typeof profile.username === 'string' ? profile.username : '';
  return name.replace(/\r\n/g, '\n').replace(/\n/g, ' ').trim();
}

// The account link next to the name in a chat run (encryptedtopicchat.js).
export function explorerUrl(accountId: string): string {
  return `https://explore.hashpack.app/${encodeURIComponent(accountId)}`;
}

function emptyProfile(accountId: string): Profile {
  return {
    accountId,
    username: '',
    profilePic: '',
    click2url: '',
    bio: '',
    topic: '',
    updatedAt: 0,
  };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// One /api/user-settings card → Profile. Rows without an account are dropped.
function profileFromSetting(row: unknown): Profile | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const accountId = str(r.accountId);
  if (!accountId) return null;
  return {
    accountId,
    username: str(r.username),
    profilePic: str(r.profilePic),
    click2url: str(r.click2url),
    bio: str(r.bio),
    topic: isTopicId(r.topic) ? r.topic : '',
    updatedAt: Number(r.updatedAt) || 0,
  };
}

// A full settings answer replaces the map. A partial one (after_rev) is
// merged over it, one card per account (loadalladata.js mergeAccounts).
export function applySettings(prev: ProfileMap, rows: unknown[], replace: boolean): ProfileMap {
  const next: ProfileMap = replace ? {} : { ...prev };
  for (const row of rows || []) {
    const profile = profileFromSetting(row);
    if (profile) next[profile.accountId] = profile;
  }
  return next;
}

// server/profiletopic.js. Connect writes profileTopic, remove writes
// clearProfileTopic, an old topic2pic message is still read.
export function profileTopicAction(
  data: unknown
): { action: 'set'; topic: string } | { action: 'clear' } | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const has = (key: string) => Object.prototype.hasOwnProperty.call(d, key);
  if (has('clearProfileTopic')) return { action: 'clear' };
  if (has('profileTopic')) {
    const topic = typeof d.profileTopic === 'string' ? d.profileTopic.trim() : '';
    if (TOPIC_ID.test(topic)) return { action: 'set', topic };
    if (!topic) return { action: 'clear' };
    return null;
  }
  if (has('topic2pic')) {
    const raw = Array.isArray(d.topic2pic) ? d.topic2pic[0] : d.topic2pic;
    const topic = typeof raw === 'string' ? raw.trim() : '';
    if (TOPIC_ID.test(topic)) return { action: 'set', topic };
    if (!topic) return { action: 'clear' };
  }
  return null;
}

function rowTimeMs(row: TopicRow): number {
  const ts = Number(row.consensus_timestamp);
  if (Number.isFinite(ts) && ts > 0) return ts * 1000;
  const created = Date.parse(String(row.created || ''));
  return Number.isFinite(created) ? created : 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

// The four profile topics, each oldest → newest. The last valid value per
// field wins, with the server's limits (username < 20, bio < 256).
export function profilesFromTopics(byKind: Partial<Record<ProfileKind, TopicRow[]>>): ProfileMap {
  const out: ProfileMap = {};
  const touch = (payer: string, ms: number) => {
    const p = out[payer] || (out[payer] = emptyProfile(payer));
    if (ms > p.updatedAt) p.updatedAt = ms;
    return p;
  };
  const kinds: ProfileKind[] = ['username', 'pic', 'click', 'bio'];
  for (const kind of kinds) {
    for (const row of byKind[kind] || []) {
      if (!row || row.pending) continue;
      const payer = str(row.payer);
      if (!isTopicId(payer)) continue;
      const data = row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : null;
      if (!data) continue;
      const ms = rowTimeMs(row);
      if (kind === 'username') {
        if (nonEmpty(data.username) && data.username.length < 20) touch(payer, ms).username = data.username;
      } else if (kind === 'pic') {
        const urls = data.urls;
        if (Array.isArray(urls) && nonEmpty(urls[0])) touch(payer, ms).profilePic = urls[0];
      } else if (kind === 'click') {
        const links = data.click2url;
        if (Array.isArray(links) && nonEmpty(links[0])) touch(payer, ms).click2url = links[0];
      } else {
        const bio = Array.isArray(data.topic_bio) ? data.topic_bio[0] : data.topic_bio;
        if (nonEmpty(bio) && bio.length < 256) touch(payer, ms).bio = bio;
        const link = profileTopicAction(data);
        if (link && link.action === 'set') touch(payer, ms).topic = link.topic;
        else if (link && link.action === 'clear' && out[payer]) touch(payer, ms).topic = '';
      }
    }
  }
  return out;
}

// The account → topic links on the bio topic, oldest → newest: the latest
// connect (profileTopic, or an old topic2pic) or remove (clearProfileTopic)
// per payer wins. '' means the payer removed their topic. This is how
// step_by_step connects a topic to a profile (Edit profile → Connect,
// followtopic.js connectProfileTopic).
export function topicLinksFromBio(rows: TopicRow[]): Record<string, string> {
  const links: Record<string, string> = {};
  for (const row of rows || []) {
    if (!row || row.pending) continue;
    const payer = str(row.payer);
    if (!isTopicId(payer)) continue;
    const data = row.data && typeof row.data === 'object' ? row.data : null;
    const link = profileTopicAction(data);
    if (link) links[payer] = link.action === 'set' ? link.topic : '';
  }
  return links;
}

// The chain's links win over the relay's saved copy, which can miss links
// written in a format it learned later (an old topic2pic).
export function withTopicLinks(profiles: ProfileMap, links: Record<string, string>): ProfileMap {
  let next: ProfileMap | null = null;
  for (const [payer, topic] of Object.entries(links)) {
    const prev = profiles[payer];
    if ((prev ? prev.topic : '') === topic) continue;
    if (!next) next = { ...profiles };
    next[payer] = { ...(prev || emptyProfile(payer)), topic };
  }
  return next || profiles;
}

export interface DomainEntry {
  domain: string;
  topic: string;
  payer: string;
  // Unix seconds when the current owner's time runs out.
  until: number;
}

// loaddomains.js. Per domain, walk the purchases in time order:
//   same owner before lapse  → adds 28 days
//   same owner after lapse   → re-bought, window restarts
//   other payer while live   → ignored
//   other payer after lapse  → takeover
// Only domains still live now are kept, and none that look like an id.
export function activeDomains(rows: TopicRow[], nowSec: number): DomainEntry[] {
  const byDomain = new Map<string, Array<{ topic: string; payer: string; t: number }>>();
  for (const row of rows || []) {
    if (!row || row.pending) continue;
    const payer = str(row.payer);
    const domain = str(row.domain);
    if (!payer || !domain) continue;
    const t = parseFloat(String(row.consensus_timestamp ?? ''));
    if (!Number.isFinite(t)) continue;
    let list = byDomain.get(domain);
    if (!list) byDomain.set(domain, (list = []));
    list.push({ topic: str(row.topic), payer, t });
  }
  const out: DomainEntry[] = [];
  for (const [domain, buys] of byDomain) {
    buys.sort((a, b) => a.t - b.t);
    let owner = buys[0].payer;
    let windowEnd = buys[0].t + DOMAIN_SECONDS;
    let last = buys[0];
    for (let i = 1; i < buys.length; i++) {
      const buy = buys[i];
      if (buy.payer === owner) {
        windowEnd = buy.t < windowEnd ? windowEnd + DOMAIN_SECONDS : buy.t + DOMAIN_SECONDS;
        last = buy;
      } else if (buy.t >= windowEnd) {
        owner = buy.payer;
        windowEnd = buy.t + DOMAIN_SECONDS;
        last = buy;
      }
    }
    if (windowEnd <= nowSec) continue;
    if (domain.includes('0.0.')) continue;
    out.push({ domain, topic: last.topic, payer: last.payer, until: windowEnd });
  }
  return out;
}

export type ResolvedTopic = { topicId: string; via: string | null } | { error: string };

export const RESOLVE_EMPTY = 'Please enter a Topic ID or domain.';

export const PICK_PERSON = 'Tap them under People to open their connected topic.';

function noTopicError(accountId: string): string {
  return `${accountId} has no public topic connected — connect one in Edit profile first.`;
}

// The topic field takes a topic id or a domain only. A user (account id or
// username) is never opened from the field: their row under Following or
// People is tapped, and resolvePerson opens their connected topic. A typed
// name would otherwise let a copied username win, and a typed account id
// would open whatever topic it points at without the person being shown.
// isAccount asks the mirror whether a 0.0.N id is an account (account and
// topic ids share that shape).
export async function resolveTopicInput(
  input: string,
  ctx: {
    domains: DomainEntry[];
    profiles: ProfileMap;
    isAccount: (id: string) => Promise<boolean>;
  }
): Promise<ResolvedTopic> {
  const value = String(input || '').trim().toLowerCase();
  if (!value) return { error: RESOLVE_EMPTY };
  const domain = ctx.domains.find((entry) => entry.domain === value);
  if (domain && isTopicId(domain.topic)) return { topicId: domain.topic, via: domain.domain };
  const bare = value.split('-')[0];
  if (/^(0\.0\.\d+)(?:-[a-z0-9]+)?$/.test(value)) {
    const known = ctx.profiles[bare];
    if (known && known.topic) return { error: `${bare} is an account. ${PICK_PERSON}` };
    if (known || (await ctx.isAccount(bare))) return { error: noTopicError(bare) };
    return { topicId: bare, via: null };
  }
  if (Object.values(ctx.profiles).some((p) => displayName(p).toLowerCase() === value)) {
    return { error: `"${value}" is a username. ${PICK_PERSON}` };
  }
  return { error: 'No domain by that name. Enter a topic ID (0.0.123) or a domain.' };
}

// A person tapped under Following or People: open the topic connected to
// their profile (encryptedtopicchat.js resolveE2eeTopic's payer branch),
// labelled with their account id.
export function resolvePerson(accountId: string, profiles: ProfileMap): ResolvedTopic {
  const bare = String(accountId || '').trim().toLowerCase().split('-')[0];
  if (!isTopicId(bare)) return { error: 'Not an account id' };
  const topic = profiles[bare] && profiles[bare].topic;
  if (isTopicId(topic)) return { topicId: topic, via: bare };
  return { error: noTopicError(bare) };
}

export interface FollowedAccount {
  id: string;
  username: string;
  avatar: string;
  topic: string;
}

// GET /api/following → accounts. A body without ok is a failed read.
export function followingFromRelay(data: unknown): FollowedAccount[] | null {
  if (!data || typeof data !== 'object' || !(data as { ok?: unknown }).ok) return null;
  const accounts = (data as { accounts?: unknown }).accounts;
  const out: FollowedAccount[] = [];
  for (const row of Array.isArray(accounts) ? accounts : []) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (!isTopicId(r.id)) continue;
    out.push({ id: r.id, username: str(r.username), avatar: str(r.avatar), topic: str(r.topic) });
  }
  return out;
}

// The follow topic, oldest → newest. The payer is the follower and the body
// names the followee; the latest message for a pair wins. (The relay also
// counts follows of someone's profile topic. Those live on every topic, so
// the direct read cannot see them.)
export function followeesFromTopic(account: string, rows: TopicRow[]): string[] {
  const state = new Map<string, boolean>();
  for (const row of rows || []) {
    if (!row || row.pending || row.payer !== account) continue;
    if (isTopicId(row.follow)) {
      state.set(row.follow, true);
    } else if (isTopicId(row.unfollow)) {
      state.set(row.unfollow, false);
    }
  }
  return [...state.entries()]
    .filter(([, on]) => on)
    .map(([id]) => id)
    .sort();
}

export function followedFromProfiles(ids: string[], profiles: ProfileMap): FollowedAccount[] {
  return ids.map((id) => {
    const p = profiles[id];
    return {
      id,
      username: p ? p.username : '',
      avatar: p ? p.profilePic : '',
      topic: p ? p.topic : '',
    };
  });
}

export interface FollowItem {
  id: string;
  username: string;
  avatar: string;
  topic: string;
  // E2EE chat: an account without a connected topic can't be messaged.
  dim: boolean;
}

function matches(query: string, ...fields: string[]): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return fields.some((field) => String(field || '').toLowerCase().includes(needle));
}

// followsuggest.js buildItems for the E2EE input (accounts, dimMissing).
// The client's own profile cards win over the relay's copy. Accounts with a
// topic sort first; otherwise the relay order (by id) stays.
export function followItems(
  accounts: FollowedAccount[],
  profiles: ProfileMap,
  query: string
): FollowItem[] {
  const items: FollowItem[] = [];
  for (const account of accounts || []) {
    if (!account || !account.id) continue;
    const id = account.id;
    const p = profiles[id];
    const username = (p && p.username) || account.username || '';
    const topic = (p && p.topic) || account.topic || '';
    if (!matches(query, username, id, topic)) continue;
    const avatar = safeHttpUrl(p && p.profilePic) || safeHttpUrl(account.avatar) || DEFAULT_AVATAR;
    items.push({ id, username, avatar, topic, dim: !topic });
  }
  items.sort((a, b) => (a.dim === b.dim ? 0 : a.dim ? 1 : -1));
  return items;
}

// Search by user: every account with a profile card whose username, id, or
// connected topic contains the query, minus ids already listed (Following).
// Accounts with a topic come first, then names that start with the query.
export function peopleItems(profiles: ProfileMap, query: string, exclude: Set<string>): FollowItem[] {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const items: FollowItem[] = [];
  for (const p of Object.values(profiles)) {
    if (!p || exclude.has(p.accountId)) continue;
    const username = displayName(p);
    if (!matches(q, username, p.accountId, p.topic)) continue;
    items.push({ id: p.accountId, username, avatar: avatarFor(p), topic: p.topic, dim: !p.topic });
  }
  const rank = (i: FollowItem) => (i.dim ? 2 : 0) + (i.username.toLowerCase().startsWith(q) ? 0 : 1);
  items.sort((a, b) => rank(a) - rank(b) || (a.username || a.id).localeCompare(b.username || b.id));
  return items;
}

// followingstate.js followingEmptyText, for the list under the topic input.
export type FollowingStatus = 'nowallet' | 'loading' | 'ready' | 'offline';

export function followingEmptyText(status: FollowingStatus, itemCount: number, rowCount: number): string {
  if (status === 'nowallet') return 'Connect your wallet to see who you follow';
  if (status === 'offline') return "Couldn't load who you follow. Tap to retry";
  if (status !== 'ready') return itemCount ? '' : 'Loading';
  if (!itemCount) return 'Not following anyone yet';
  if (!rowCount) return 'No matches';
  return '';
}
