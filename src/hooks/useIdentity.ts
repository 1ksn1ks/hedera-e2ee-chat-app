// Profiles (picture, username, link, connected topic), active domains, and
// the wallet's following list — loaded the way the Globe map loads them:
// profiles at launch and every 30s while visible (loadalladata.js), domains
// once (loaddomains.js), following per wallet with a 5 minute cache
// (followingstate.js). Every read checks the current switch, so Direct
// Hedera never contacts the relay.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import {
  applySettings,
  isTopicId,
  resolvePerson,
  resolveTopicInput,
  type DomainEntry,
  type FollowedAccount,
  type FollowingStatus,
  type ProfileMap,
  type ResolvedTopic,
  withTopicLinks,
} from '../services/identity';
import {
  fetchUserSettings,
  isHederaAccount,
  loadDomains,
  loadFollowing,
  loadProfilesFromTopics,
  loadTopicLinks,
} from '../services/identityFetch';
import type { TransportMode } from '../services/transport';

const PROFILE_POLL_MS = 30000;
const FOLLOWING_CACHE_MS = 5 * 60 * 1000;
const FOLLOWING_RETRY_MS = 1500;
// An unknown name re-reads the domain topic, at most this often.
const DOMAIN_RECHECK_MS = 10000;
// A payer without a known topic re-reads the bio topic, at most this often.
const LINK_RECHECK_MS = 5000;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function useIdentity(getMode: () => TransportMode, account: string | null) {
  const [profiles, setProfiles] = useState<ProfileMap>({});
  const [following, setFollowing] = useState<FollowedAccount[]>([]);
  const [followingStatus, setFollowingStatus] = useState<FollowingStatus>('nowallet');

  const getModeRef = useRef(getMode);
  getModeRef.current = getMode;
  const accountRef = useRef(account);
  accountRef.current = account;
  const profilesRef = useRef<ProfileMap>({});
  const settingsRef = useRef({ generation: '', revision: 0 });
  const profilesRun = useRef<Promise<void> | null>(null);
  const domainsRef = useRef<DomainEntry[]>([]);
  const domainsAt = useRef(0);
  const domainsRun = useRef<Promise<void> | null>(null);
  const linksAt = useRef(0);
  const followSerial = useRef(0);
  const followingFor = useRef<{ account: string; at: number } | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState || 'active');

  const putProfiles = (next: ProfileMap) => {
    profilesRef.current = next;
    setProfiles(next);
  };

  const refreshProfiles = useCallback((): Promise<void> => {
    if (profilesRun.current) return profilesRun.current;
    const run = (async () => {
      const mode = getModeRef.current();
      if (mode === 'relay') {
        const { generation, revision } = settingsRef.current;
        const [remote, links] = await Promise.all([
          fetchUserSettings(revision, generation),
          loadTopicLinks(mode),
        ]);
        if (remote.ready) {
          // A new database id, or no copy yet, is a full list. Otherwise only
          // the cards written after our revision.
          const replace = remote.generation !== generation || !(revision > 0);
          settingsRef.current = { generation: remote.generation, revision: remote.revision };
          let next =
            replace || remote.settings.length
              ? applySettings(profilesRef.current, remote.settings, replace)
              : profilesRef.current;
          // Connected topics come from the chain itself: the relay's saved
          // copy can miss a link (an old topic2pic connect).
          if (links) {
            next = withTopicLinks(next, links);
            linksAt.current = Date.now();
          }
          if (next !== profilesRef.current) putProfiles(next);
          return;
        }
      }
      const direct = await loadProfilesFromTopics(getModeRef.current());
      if (direct) {
        // A direct read is a full set (links included). The next relay read
        // starts over.
        settingsRef.current = { generation: '', revision: 0 };
        linksAt.current = Date.now();
        putProfiles(direct);
      }
    })().finally(() => {
      profilesRun.current = null;
    });
    profilesRun.current = run;
    return run;
  }, []);

  const refreshDomains = useCallback((): Promise<void> => {
    if (domainsRun.current) return domainsRun.current;
    const run = (async () => {
      const list = await loadDomains(getModeRef.current());
      if (list) {
        domainsRef.current = list;
        domainsAt.current = Date.now();
      }
    })().finally(() => {
      domainsRun.current = null;
    });
    domainsRun.current = run;
    return run;
  }, []);

  // An account id with no topic on file: look up their connected topic on
  // the chain now, in case they connected it after the last refresh.
  const freshLinksFor = useCallback(async (bare: string): Promise<void> => {
    const known = profilesRef.current[bare];
    if (!isTopicId(bare) || (known && known.topic)) return;
    if (Date.now() - linksAt.current <= LINK_RECHECK_MS) return;
    const links = await loadTopicLinks(getModeRef.current());
    if (links) {
      linksAt.current = Date.now();
      putProfiles(withTopicLinks(profilesRef.current, links));
    }
  }, []);

  const launchReads = useCallback(async () => {
    if (!domainsAt.current) await refreshDomains();
    else if (domainsRun.current) await domainsRun.current;
    if (profilesRun.current) await profilesRun.current;
  }, [refreshDomains]);

  // The topic field: a topic id or a domain. Waits for the launch reads so
  // a domain typed right away still resolves.
  const resolve = useCallback(
    async (input: string): Promise<ResolvedTopic> => {
      await launchReads();
      const value = String(input || '').trim().toLowerCase();
      await freshLinksFor(value.split('-')[0]);
      const ctx = () => ({
        domains: domainsRef.current,
        profiles: profilesRef.current,
        isAccount: isHederaAccount,
      });
      let res = await resolveTopicInput(input, ctx());
      // Not an id and not a known domain: it may have been bought just now.
      if ('error' in res && !/^\d+\.\d+\.\d+/.test(value) && Date.now() - domainsAt.current > DOMAIN_RECHECK_MS) {
        await refreshDomains();
        res = await resolveTopicInput(input, ctx());
      }
      return res;
    },
    [freshLinksFor, launchReads, refreshDomains]
  );

  // A person tapped under Following or People → their connected topic.
  const resolvePersonTopic = useCallback(
    async (accountId: string): Promise<ResolvedTopic> => {
      await launchReads();
      const bare = String(accountId || '').trim().toLowerCase().split('-')[0];
      await freshLinksFor(bare);
      return resolvePerson(bare, profilesRef.current);
    },
    [freshLinksFor, launchReads]
  );

  // force skips the 5 minute cache (the retry tap).
  const refreshFollowing = useCallback(async (force = false): Promise<void> => {
    const acc = accountRef.current;
    const serial = ++followSerial.current;
    if (!acc) {
      followingFor.current = null;
      setFollowing([]);
      setFollowingStatus('nowallet');
      return;
    }
    const cached = followingFor.current;
    if (!force && cached && cached.account === acc && Date.now() - cached.at < FOLLOWING_CACHE_MS) return;
    setFollowingStatus('loading');
    // The direct path fills names from the profile cards.
    if (profilesRun.current) await profilesRun.current;
    let list = await loadFollowing(acc, getModeRef.current(), profilesRef.current);
    if (!list && serial === followSerial.current) {
      await delay(FOLLOWING_RETRY_MS);
      if (serial !== followSerial.current) return;
      list = await loadFollowing(acc, getModeRef.current(), profilesRef.current);
    }
    if (serial !== followSerial.current) return;
    if (!list) {
      followingFor.current = null;
      setFollowing([]);
      setFollowingStatus('offline');
      return;
    }
    followingFor.current = { account: acc, at: Date.now() };
    setFollowing(list);
    setFollowingStatus('ready');
  }, []);

  useEffect(() => {
    void refreshProfiles();
    void refreshDomains();
    const visible = () =>
      !(typeof document !== 'undefined' && document.visibilityState === 'hidden') &&
      appStateRef.current !== 'background';
    const timer = setInterval(() => {
      if (visible()) void refreshProfiles();
    }, PROFILE_POLL_MS);
    const onVis = () => {
      if (visible()) void refreshProfiles();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
    const sub = AppState.addEventListener('change', (state) => {
      appStateRef.current = state;
      if (state === 'active') void refreshProfiles();
    });
    return () => {
      clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
      sub.remove();
    };
  }, [refreshProfiles, refreshDomains]);

  useEffect(() => {
    void refreshFollowing();
  }, [account, refreshFollowing]);

  // resolve: the topic field. resolvePerson: a tapped Following/People row.
  return { profiles, following, followingStatus, refreshFollowing, resolve, resolvePerson: resolvePersonTopic };
}
