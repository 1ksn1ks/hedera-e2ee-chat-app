// Network side of identity.ts. Relay first unless the switch is off; a
// failed or not-ready relay read falls back to the public mirror, the same
// rule the chat history uses. Direct Hedera never contacts the relay.
import { BACKEND_URL, fetchMessages, type AppMessage } from './backend';
import { fetchMirrorHistory, MIRROR_ORIGIN } from './mirror';
import type { TransportMode } from './transport';
import {
  activeDomains,
  DOMAIN_TOPIC,
  FOLLOW_TOPIC,
  followedFromProfiles,
  followeesFromTopic,
  followingFromRelay,
  PROFILE_TOPICS,
  profilesFromTopics,
  topicLinksFromBio,
  type DomainEntry,
  type FollowedAccount,
  type ProfileKind,
  type ProfileMap,
} from './identity';

// msgbackend.js: settings read 8s, following read 4s, account check 4s.
const SETTINGS_TIMEOUT_MS = 8000;
const FOLLOWING_TIMEOUT_MS = 4000;
const ACCOUNT_TIMEOUT_MS = 4000;

async function getJson(url: string, timeoutMs: number): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface SettingsRead {
  ready: boolean;
  generation: string;
  revision: number;
  settings: unknown[];
}

// GET /api/user-settings. ready=false: offline, or the profile topics are
// not backfilled yet. after_rev + generation asks only for changed cards.
export async function fetchUserSettings(afterRev: number, generation: string): Promise<SettingsRead> {
  const params: string[] = [];
  const after = Math.floor(Number(afterRev) || 0);
  if (after > 0) params.push(`after_rev=${after}`);
  if (generation) params.push(`generation=${encodeURIComponent(generation)}`);
  const query = params.length ? `?${params.join('&')}` : '';
  const data = (await getJson(`${BACKEND_URL}/api/user-settings${query}`, SETTINGS_TIMEOUT_MS)) as
    | { ready?: unknown; generation?: unknown; revision?: unknown; settings?: unknown }
    | null;
  if (!data) return { ready: false, generation: '', revision: 0, settings: [] };
  return {
    ready: !!data.ready,
    generation: typeof data.generation === 'string' ? data.generation : '',
    revision: Number(data.revision) || 0,
    settings: Array.isArray(data.settings) ? data.settings : [],
  };
}

// One small topic, chronological, confirmed rows only. null = both paths failed.
export async function readTopic(topicId: string, mode: TransportMode): Promise<AppMessage[] | null> {
  if (mode === 'relay') {
    const data = await fetchMessages(topicId, 1000);
    if (!data.failed && !data.timedOut && data.ready) return data.messages.filter((m) => !m.pending);
  }
  try {
    return (await fetchMirrorHistory(topicId)).messages;
  } catch {
    return null;
  }
}

// The four profile topics read directly. A topic that can't be read keeps
// the previous cards (null), so one blip can't wipe every name.
export async function loadProfilesFromTopics(mode: TransportMode): Promise<ProfileMap | null> {
  const kinds = Object.keys(PROFILE_TOPICS) as ProfileKind[];
  const reads = await Promise.all(kinds.map((kind) => readTopic(PROFILE_TOPICS[kind], mode)));
  if (reads.some((rows) => rows === null)) return null;
  const byKind: Partial<Record<ProfileKind, AppMessage[]>> = {};
  kinds.forEach((kind, i) => {
    byKind[kind] = reads[i] || [];
  });
  return profilesFromTopics(byKind);
}

// Account → topic links straight from the bio topic (tiny). null = unread.
export async function loadTopicLinks(mode: TransportMode): Promise<Record<string, string> | null> {
  const rows = await readTopic(PROFILE_TOPICS.bio, mode);
  return rows ? topicLinksFromBio(rows) : null;
}

export async function loadDomains(mode: TransportMode): Promise<DomainEntry[] | null> {
  const rows = await readTopic(DOMAIN_TOPIC, mode);
  if (!rows) return null;
  return activeDomains(rows, Date.now() / 1000);
}

async function fetchFollowingRelay(account: string): Promise<FollowedAccount[] | null> {
  const data = await getJson(
    `${BACKEND_URL}/api/following?account=${encodeURIComponent(account)}`,
    FOLLOWING_TIMEOUT_MS
  );
  return followingFromRelay(data);
}

// Accounts this wallet follows. null = could not be read.
export async function loadFollowing(
  account: string,
  mode: TransportMode,
  profiles: ProfileMap
): Promise<FollowedAccount[] | null> {
  if (mode === 'relay') {
    const relay = await fetchFollowingRelay(account);
    if (relay) return relay;
  }
  let rows: AppMessage[];
  try {
    rows = (await fetchMirrorHistory(FOLLOW_TOPIC)).messages;
  } catch {
    return null;
  }
  return followedFromProfiles(followeesFromTopic(account, rows), profiles);
}

const accountChecks = new Map<string, boolean>();

// handleallmessages.js isHederaAccount. A 404 is a definite "not an
// account" (likely a topic); any other failure is "don't know" → false,
// and only definite answers are cached.
export async function isHederaAccount(id: string): Promise<boolean> {
  if (!id) return false;
  const known = accountChecks.get(id);
  if (known !== undefined) return known;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ACCOUNT_TIMEOUT_MS);
  try {
    const res = await fetch(`${MIRROR_ORIGIN}/api/v1/accounts/${encodeURIComponent(id)}`, {
      signal: ctrl.signal,
    });
    if (res.status === 404) {
      accountChecks.set(id, false);
      return false;
    }
    if (!res.ok) return false;
    accountChecks.set(id, true);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
