import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeDomains,
  applySettings,
  chatSenders,
  avatarFor,
  DEFAULT_AVATAR,
  displayName,
  DOMAIN_SECONDS,
  followeesFromTopic,
  followingEmptyText,
  followingFromRelay,
  followItems,
  profilesFromTopics,
  peopleItems,
  profileTopicAction,
  resolvePerson,
  resolveTopicInput,
  safeHttpUrl,
  topicLinksFromBio,
  withTopicLinks,
  type ProfileMap,
  type TopicRow,
} from './identity.ts';

const row = (payer: string, ts: number, body: Record<string, unknown>): TopicRow => ({
  ...body,
  payer,
  consensus_timestamp: `${ts}.000000001`,
  created: new Date(ts * 1000).toISOString(),
});

test('settings cards replace on a full read and merge on a partial one', () => {
  const full = applySettings(
    {},
    [
      { accountId: '0.0.1', username: 'ann', profilePic: 'https://x/a.jpg', topic: '0.0.50', updatedAt: 5 },
      { accountId: '0.0.2', username: 'bob', topic: 'not-a-topic' },
      { username: 'no id' },
    ],
    true
  );
  assert.deepEqual(Object.keys(full).sort(), ['0.0.1', '0.0.2']);
  assert.equal(full['0.0.1'].topic, '0.0.50');
  assert.equal(full['0.0.2'].topic, '');
  const merged = applySettings(full, [{ accountId: '0.0.2', username: 'bobby' }], false);
  assert.equal(merged['0.0.1'].username, 'ann');
  assert.equal(merged['0.0.2'].username, 'bobby');
  const replaced = applySettings(full, [{ accountId: '0.0.3', username: 'cy' }], true);
  assert.deepEqual(Object.keys(replaced), ['0.0.3']);
});

test('profile topics: latest valid value per field wins, with the server limits', () => {
  const profiles = profilesFromTopics({
    username: [
      row('0.0.1', 10, { data: { username: 'first' } }),
      row('0.0.1', 20, { data: { username: 'x'.repeat(20) } }), // too long: ignored
      row('0.0.1', 30, { data: { username: 'second' } }),
      { ...row('0.0.1', 40, { data: { username: 'pending' } }), pending: true },
    ],
    pic: [
      row('0.0.1', 10, { data: { urls: ['https://x/old.jpg'] } }),
      row('0.0.1', 11, { data: { urls: [] } }),
      row('0.0.1', 12, { data: { urls: ['https://x/new.jpg'] } }),
    ],
    click: [row('0.0.1', 10, { data: { click2url: ['https://site.example'] } })],
    bio: [
      row('0.0.1', 10, { data: { topic_bio: ['hello'], profileTopic: '0.0.77' } }),
      row('0.0.2', 10, { data: { topic_bio: 'old string bio', topic2pic: ['0.0.88'] } }),
      row('0.0.2', 20, { data: { clearProfileTopic: '1' } }),
      row('0.0.3', 10, { data: { topic_bio: 'y'.repeat(256) } }), // too long: ignored
    ],
  });
  assert.equal(profiles['0.0.1'].username, 'second');
  assert.equal(profiles['0.0.1'].profilePic, 'https://x/new.jpg');
  assert.equal(profiles['0.0.1'].click2url, 'https://site.example');
  assert.equal(profiles['0.0.1'].bio, 'hello');
  assert.equal(profiles['0.0.1'].topic, '0.0.77');
  assert.equal(profiles['0.0.2'].bio, 'old string bio');
  assert.equal(profiles['0.0.2'].topic, '');
  assert.equal(profiles['0.0.3'], undefined);
});

test('profileTopicAction matches the server rules', () => {
  assert.deepEqual(profileTopicAction({ profileTopic: ' 0.0.5 ' }), { action: 'set', topic: '0.0.5' });
  assert.deepEqual(profileTopicAction({ profileTopic: '' }), { action: 'clear' });
  assert.equal(profileTopicAction({ profileTopic: 'junk' }), null);
  assert.deepEqual(profileTopicAction({ clearProfileTopic: '1', profileTopic: '0.0.5' }), { action: 'clear' });
  assert.deepEqual(profileTopicAction({ topic2pic: ['0.0.9'] }), { action: 'set', topic: '0.0.9' });
  assert.equal(profileTopicAction({ topic_bio: 'only a bio' }), null);
});

test('domains follow the 28-day ownership chain', () => {
  const t0 = 1_000_000;
  const rows = [
    row('0.0.1', t0, { domain: 'alpha', topic: '0.0.100' }),
    // other payer while live: ignored
    row('0.0.2', t0 + 10, { domain: 'alpha', topic: '0.0.200' }),
    // owner extends before lapse: +28 days, topic moves
    row('0.0.1', t0 + 20, { domain: 'alpha', topic: '0.0.101' }),
    row('0.0.3', t0, { domain: 'beta', topic: '0.0.300' }),
    // beta lapsed, then taken over
    row('0.0.4', t0 + DOMAIN_SECONDS + 5, { domain: 'beta', topic: '0.0.400' }),
    row('0.0.5', t0, { domain: 'gamma', topic: '0.0.500' }),
    row('0.0.6', t0, { domain: 'has0.0.id', topic: '0.0.600' }),
    { ...row('0.0.7', t0, { domain: 'delta', topic: '0.0.700' }), pending: true },
  ];
  const now = t0 + DOMAIN_SECONDS + 100;
  const byName = Object.fromEntries(activeDomains(rows, now).map((d) => [d.domain, d]));
  assert.equal(byName.alpha.topic, '0.0.101');
  assert.equal(Math.round(byName.alpha.until), t0 + 2 * DOMAIN_SECONDS);
  assert.equal(byName.beta.topic, '0.0.400');
  assert.equal(byName.beta.payer, '0.0.4');
  assert.equal(byName.gamma, undefined, 'expired');
  assert.equal(byName['has0.0.id'], undefined, 'id-shaped names are dropped');
  assert.equal(byName.delta, undefined, 'pending rows are not purchases');
});

test('the topic field takes a topic id or a domain; a user must be tapped', async () => {
  const profiles: ProfileMap = applySettings(
    {},
    [
      { accountId: '0.0.10', username: 'has topic', topic: '0.0.900' },
      { accountId: '0.0.11', username: 'no topic' },
    ],
    true
  );
  const domains = [{ domain: 'alpha', topic: '0.0.101', payer: '0.0.1', until: 9e12 }];
  const accounts = new Set(['0.0.10', '0.0.11', '0.0.12']);
  const asked: string[] = [];
  const ctx = {
    domains,
    profiles,
    isAccount: async (id: string) => {
      asked.push(id);
      return accounts.has(id);
    },
  };
  const err = async (input: string) => ((await resolveTopicInput(input, ctx)) as { error: string }).error;
  assert.deepEqual(await resolveTopicInput('  Alpha ', ctx), { topicId: '0.0.101', via: 'alpha' });
  assert.deepEqual(await resolveTopicInput('0.0.555', ctx), { topicId: '0.0.555', via: null });
  assert.deepEqual(await resolveTopicInput('0.0.555-abcde', ctx), { topicId: '0.0.555', via: null }, 'checksum dropped');
  assert.match(await err('0.0.10'), /^0\.0\.10 is an account\. Tap them under People/, 'a typed account never opens');
  assert.match(await err('0.0.10-abcde'), /^0\.0\.10 is an account/);
  assert.match(await err('0.0.11'), /^0\.0\.11 has no public topic connected/);
  assert.match(await err('0.0.12'), /^0\.0\.12 has no public topic connected/, 'an account without a profile card');
  assert.match(await err('Has Topic'), /is a username\. Tap them under People/, 'a typed username never opens');
  assert.match(await err('unknown words'), /^No domain by that name/);
  assert.ok('error' in (await resolveTopicInput('   ', ctx)));
  assert.deepEqual(asked, ['0.0.555', '0.0.555', '0.0.12'], 'the mirror is asked only about unknown ids');
});

test('a tapped person opens the topic connected to their profile', () => {
  const profiles = applySettings(
    {},
    [
      { accountId: '0.0.10', username: 'has topic', topic: '0.0.900' },
      { accountId: '0.0.11', username: 'no topic' },
    ],
    true
  );
  assert.deepEqual(resolvePerson('0.0.10', profiles), { topicId: '0.0.900', via: '0.0.10' });
  assert.deepEqual(resolvePerson(' 0.0.10-abcde ', profiles), { topicId: '0.0.900', via: '0.0.10' });
  assert.match((resolvePerson('0.0.11', profiles) as { error: string }).error, /has no public topic connected/);
  assert.match((resolvePerson('0.0.99', profiles) as { error: string }).error, /has no public topic connected/);
});

test('follow topic replay: the latest message per followee wins', () => {
  const rows = [
    row('0.0.1', 1, { follow: '0.0.20' }),
    row('0.0.1', 2, { follow: '0.0.30' }),
    row('0.0.2', 3, { follow: '0.0.40' }), // someone else's follow
    row('0.0.1', 4, { unfollow: '0.0.20' }),
    row('0.0.1', 5, { follow: 'junk' }),
    row('0.0.1', 6, { follow: '0.0.10' }),
  ];
  assert.deepEqual(followeesFromTopic('0.0.1', rows), ['0.0.10', '0.0.30']);
  assert.deepEqual(followeesFromTopic('0.0.9', rows), []);
});

test('relay following: a body without ok is a failed read', () => {
  assert.equal(followingFromRelay(null), null);
  assert.equal(followingFromRelay({ ok: false, accounts: [] }), null);
  assert.deepEqual(
    followingFromRelay({ ok: true, accounts: [{ id: '0.0.5', username: 'e', avatar: '', topic: '0.0.6' }, { id: 'bad' }] }),
    [{ id: '0.0.5', username: 'e', avatar: '', topic: '0.0.6' }]
  );
});

test('follow rows: client cards win, topic-less accounts are dimmed and sort last, the query filters', () => {
  const profiles = applySettings(
    {},
    [{ accountId: '0.0.2', username: 'fresh name', profilePic: 'https://x/p.jpg', topic: '0.0.99' }],
    true
  );
  const accounts = [
    { id: '0.0.1', username: 'no topic', avatar: 'javascript:alert(1)', topic: '' },
    { id: '0.0.2', username: 'stale name', avatar: '', topic: '' },
    { id: '0.0.3', username: 'third', avatar: 'https://x/3.jpg', topic: '0.0.33' },
  ];
  const items = followItems(accounts, profiles, '');
  assert.deepEqual(items.map((i) => i.id), ['0.0.2', '0.0.3', '0.0.1']);
  assert.equal(items[0].username, 'fresh name');
  assert.equal(items[0].avatar, 'https://x/p.jpg');
  assert.equal(items[0].dim, false);
  assert.equal(items[2].dim, true);
  assert.equal(items[2].avatar, DEFAULT_AVATAR, 'non-http avatars fall back');
  assert.deepEqual(followItems(accounts, profiles, 'THIRD').map((i) => i.id), ['0.0.3']);
  assert.deepEqual(followItems(accounts, profiles, '0.0.99').map((i) => i.id), ['0.0.2'], 'matches the topic too');
});

test('names, avatars, links and empty texts', () => {
  assert.equal(safeHttpUrl(' https://a.example/x '), 'https://a.example/x');
  assert.equal(safeHttpUrl('javascript:alert(1)'), '');
  assert.equal(safeHttpUrl('your-custom-URL'), '');
  assert.equal(avatarFor(undefined), DEFAULT_AVATAR);
  const p = applySettings({}, [{ accountId: '0.0.1', username: 'a\r\nb\nc', profilePic: 'ftp://x' }], true)['0.0.1'];
  assert.equal(displayName(p), 'a b c');
  assert.equal(avatarFor(p), DEFAULT_AVATAR);
  assert.equal(followingEmptyText('nowallet', 0, 0), 'Connect your wallet to see who you follow');
  assert.equal(followingEmptyText('loading', 0, 0), 'Loading');
  assert.equal(followingEmptyText('loading', 2, 2), '');
  assert.equal(followingEmptyText('ready', 0, 0), 'Not following anyone yet');
  assert.equal(followingEmptyText('ready', 3, 0), 'No matches');
  assert.equal(followingEmptyText('ready', 3, 3), '');
});

test('connected topics come from the bio topic: latest connect or remove per payer', () => {
  const links = topicLinksFromBio([
    row('0.0.1', 1, { data: { topic2pic: ['0.0.100'] } }),
    row('0.0.1', 2, { data: { topic2pic: ['0.0.101'] } }), // old format, newer link wins
    row('0.0.2', 3, { data: { profileTopic: '0.0.200' } }),
    row('0.0.2', 4, { data: { clearProfileTopic: '1' } }),
    row('0.0.3', 5, { data: { topic_bio: ['bio only'] } }), // no link change
    { ...row('0.0.4', 6, { data: { profileTopic: '0.0.400' } }), pending: true },
  ]);
  assert.deepEqual(links, { '0.0.1': '0.0.101', '0.0.2': '' });
});

test('chain links win over the relay copy and add accounts it lacks', () => {
  const relay = applySettings(
    {},
    [
      { accountId: '0.0.1', username: 'stale', topic: '' }, // relay missed an old topic2pic
      { accountId: '0.0.2', username: 'kept', topic: '0.0.222' },
    ],
    true
  );
  const merged = withTopicLinks(relay, { '0.0.1': '0.0.101', '0.0.5': '0.0.555' });
  assert.equal(merged['0.0.1'].topic, '0.0.101');
  assert.equal(merged['0.0.1'].username, 'stale', 'other fields are kept');
  assert.equal(merged['0.0.2'].topic, '0.0.222', 'accounts without a chain link keep the relay value');
  assert.equal(merged['0.0.5'].topic, '0.0.555');
  assert.equal(withTopicLinks(merged, { '0.0.1': '0.0.101' }), merged, 'no change keeps the same map');
});

test('people search by username, id, or topic; topic holders first; Following excluded', () => {
  const profiles = applySettings(
    {},
    [
      { accountId: '0.0.1', username: 'alice', topic: '0.0.11' },
      { accountId: '0.0.2', username: 'malice', topic: '' },
      { accountId: '0.0.3', username: 'Alicia', topic: '0.0.33' },
      { accountId: '0.0.4', username: 'bob', topic: '0.0.44' },
    ],
    true
  );
  assert.deepEqual(peopleItems(profiles, '', new Set()), []);
  const hits = peopleItems(profiles, 'ALI', new Set());
  assert.deepEqual(hits.map((i) => i.id), ['0.0.1', '0.0.3', '0.0.2']);
  assert.equal(hits[2].dim, true);
  assert.deepEqual(peopleItems(profiles, 'ali', new Set(['0.0.1'])).map((i) => i.id), ['0.0.3', '0.0.2']);
  assert.deepEqual(peopleItems(profiles, '0.0.44', new Set()).map((i) => i.id), ['0.0.4'], 'matches a connected topic');
});

test('chat senders: everyone who wrote, A-Z by shown name, with counts', () => {
  const profiles = applySettings(
    {},
    [
      { accountId: '0.0.3', username: 'zed', profilePic: 'https://x/z.jpg' },
      { accountId: '0.0.1', username: 'Alice' },
    ],
    true
  );
  const bubbles = [
    { payer: '0.0.3', mine: false },
    { payer: '0.0.1', mine: false },
    { payer: '0.0.20', mine: true },
    { payer: '0.0.3', mine: false },
    { payer: '0.0.1', mine: false },
    { payer: '0.0.3', mine: false },
  ];
  const senders = chatSenders(bubbles, profiles);
  assert.deepEqual(
    senders.map((s) => [s.name, s.count, s.mine]),
    [
      ['0.0.20', 1, true],
      ['Alice', 2, false],
      ['zed', 3, false],
    ]
  );
  assert.equal(senders[2].avatar, 'https://x/z.jpg');
  assert.equal(senders[0].avatar, DEFAULT_AVATAR, 'no profile: default picture, account id as name');
  assert.deepEqual(chatSenders([], profiles), []);
});
