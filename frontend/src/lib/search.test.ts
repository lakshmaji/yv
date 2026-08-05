import { describe, it, expect } from 'vitest';
import {
  queryTokens, scoreCommand, matchesQuery, searchCommands, searchAllProjects, hasHooks,
  type Searchable,
} from './search';

const cmd = (label: string, command: string, group = ''): Searchable => ({ label, command, group });

describe('queryTokens', () => {
  const cases: Array<{ name: string; query: string; want: string[] }> = [
    { name: 'single word', query: 'build', want: ['build'] },
    { name: 'lowercases', query: 'BUILD APK', want: ['build', 'apk'] },
    { name: 'collapses whitespace', query: '  build   apk  ', want: ['build', 'apk'] },
    { name: 'blank query', query: '', want: [] },
    { name: 'whitespace only', query: '   ', want: [] },
    { name: 'tabs and newlines', query: 'a\tb\nc', want: ['a', 'b', 'c'] },
  ];

  for (const tc of cases) {
    it(tc.name, () => expect(queryTokens(tc.query)).toEqual(tc.want));
  }
});

describe('scoreCommand', () => {
  const target = cmd('Install APK', 'adb install -r app-release.apk', 'Android');

  const cases: Array<{ name: string; tokens: string[]; want: 'zero' | 'positive' }> = [
    { name: 'label prefix matches', tokens: ['install'], want: 'positive' },
    { name: 'label substring matches', tokens: ['apk'], want: 'positive' },
    { name: 'group matches', tokens: ['android'], want: 'positive' },
    { name: 'command body matches', tokens: ['adb'], want: 'positive' },
    { name: 'all tokens present', tokens: ['install', 'adb'], want: 'positive' },
    { name: 'one token missing', tokens: ['install', 'zzz'], want: 'zero' },
    { name: 'no tokens', tokens: [], want: 'zero' },
    { name: 'nothing matches', tokens: ['ios'], want: 'zero' },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const score = scoreCommand(target, tc.tokens);
      if (tc.want === 'zero') expect(score).toBe(0);
      else expect(score).toBeGreaterThan(0);
    });
  }

  it('ranks label prefix above label substring above command body', () => {
    const tokens = ['build'];
    const prefix = scoreCommand(cmd('Build APK', 'gradlew assemble'), tokens);
    const substring = scoreCommand(cmd('Clean Build', 'gradlew assemble'), tokens);
    const groupHit = scoreCommand(cmd('Assemble', 'gradlew assemble', 'Build'), tokens);
    const body = scoreCommand(cmd('Assemble', 'gradlew build'), tokens);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(groupHit);
    expect(groupHit).toBeGreaterThan(body);
  });

  it('tolerates missing optional fields', () => {
    expect(scoreCommand({ label: 'X', command: '' }, ['x'])).toBeGreaterThan(0);
  });
});

describe('matchesQuery', () => {
  const target = cmd('Launch App', 'adb shell am start', 'Android');

  const cases: Array<{ name: string; query: string; want: boolean }> = [
    { name: 'exact label word', query: 'launch', want: true },
    { name: 'case insensitive', query: 'LAUNCH', want: true },
    { name: 'matches command text', query: 'shell', want: true },
    { name: 'matches group', query: 'android', want: true },
    { name: 'multi token both match', query: 'launch adb', want: true },
    { name: 'multi token one misses', query: 'launch ios', want: false },
    { name: 'no match', query: 'emulator', want: false },
    { name: 'blank query matches nothing', query: '', want: false },
  ];

  for (const tc of cases) {
    it(tc.name, () => expect(matchesQuery(target, tc.query)).toBe(tc.want));
  }
});

describe('searchCommands', () => {
  const list = [
    cmd('Clean & Build Release APK', './gradlew clean && ./gradlew app:assembleRelease', 'Android'),
    cmd('Install APK', 'adb install -r app/build/outputs/apk/release/app-release.apk', 'Android'),
    cmd('Launch App', 'adb shell am start -n au.oolio.pos/.MainActivity', 'Android'),
    cmd('List AVDs', 'emulator -list-avds', 'Android'),
    cmd('Start Dev Server', 'npm run dev', 'Web'),
  ];

  const cases: Array<{ name: string; query: string; wantLabels: string[] }> = [
    {
      name: 'blank query returns everything',
      query: '',
      wantLabels: list.map(c => c.label),
    },
    {
      name: 'whitespace query returns everything',
      query: '   ',
      wantLabels: list.map(c => c.label),
    },
    {
      name: 'label matches beat command-only matches',
      query: 'apk',
      // Both labels contain "apk" (equal score) so original order is kept.
      wantLabels: ['Clean & Build Release APK', 'Install APK'],
    },
    {
      name: 'label prefix match',
      query: 'install',
      wantLabels: ['Install APK'],
    },
    {
      name: 'command body only match',
      query: 'gradlew',
      wantLabels: ['Clean & Build Release APK'],
    },
    {
      name: 'group narrows results',
      query: 'web',
      wantLabels: ['Start Dev Server'],
    },
    {
      name: 'two tokens must both match',
      query: 'adb install',
      wantLabels: ['Install APK'],
    },
    {
      name: 'no results',
      query: 'kubernetes',
      wantLabels: [],
    },
    {
      name: 'punctuation in query is treated literally',
      query: 'app:assemblerelease',
      wantLabels: ['Clean & Build Release APK'],
    },
    {
      name: 'ties keep original order',
      query: 'a',
      // Every label contains "a", so all scores tie and input order is preserved.
      wantLabels: list.map(c => c.label),
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      expect(searchCommands(list, tc.query).map(c => c.label)).toEqual(tc.wantLabels);
    });
  }

  it('does not mutate the input list', () => {
    const input = [...list];
    searchCommands(input, 'apk');
    expect(input).toEqual(list);
  });

  it('handles an empty list', () => {
    expect(searchCommands([], 'anything')).toEqual([]);
  });
});

describe('searchAllProjects', () => {
  const projects = [
    {
      id: 'pos',
      name: 'POS',
      commands: [
        cmd('Install APK', 'adb install -r app-release.apk', 'Android'),
        cmd('Launch App', 'adb shell am start', 'Android'),
      ],
    },
    {
      id: 'web',
      name: 'Storefront',
      commands: [
        cmd('Start Dev Server', 'npm run dev', 'Web'),
        cmd('Install deps', 'npm ci', 'Web'),
      ],
    },
    { id: 'empty', name: 'Empty', commands: [] },
    { id: 'nocmds', name: 'No Commands' },
  ];

  const cases: Array<{ name: string; query: string; want: Array<[string, string]> }> = [
    { name: 'blank query returns nothing', query: '', want: [] },
    { name: 'whitespace query returns nothing', query: '  ', want: [] },
    {
      name: 'spans every project',
      query: 'install',
      want: [['POS', 'Install APK'], ['Storefront', 'Install deps']],
    },
    {
      name: 'project name narrows results',
      query: 'storefront',
      want: [['Storefront', 'Start Dev Server'], ['Storefront', 'Install deps']],
    },
    {
      name: 'project name plus command token',
      query: 'storefront install',
      want: [['Storefront', 'Install deps']],
    },
    {
      name: 'group token works globally',
      query: 'android',
      want: [['POS', 'Install APK'], ['POS', 'Launch App']],
    },
    {
      name: 'command body match',
      query: 'npm',
      want: [['Storefront', 'Start Dev Server'], ['Storefront', 'Install deps']],
    },
    { name: 'no match', query: 'kubernetes', want: [] },
    {
      name: 'projects without commands are skipped safely',
      query: 'empty',
      want: [],
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const got = searchAllProjects(projects, tc.query).map(r => [r.projectName, r.cmd.label]);
      expect(got).toEqual(tc.want);
    });
  }

  it('carries the project id for navigation', () => {
    const [first] = searchAllProjects(projects, 'launch');
    expect(first.projectId).toBe('pos');
    expect(first.cmd.label).toBe('Launch App');
  });

  it('respects the result limit', () => {
    expect(searchAllProjects(projects, 'a', 2)).toHaveLength(2);
  });

  it('handles an empty project list', () => {
    expect(searchAllProjects([], 'anything')).toEqual([]);
  });
});

describe('hook matching', () => {
  const withHooks: Searchable = {
    label: 'Tilt',
    command: 'tilt up',
    group: 'Dev',
    preCommands: ['direnv allow .', 'aws sso login --profile staging'],
    postCommands: [{ command: 'kubectl get pods' }, { command: 'echo ready' }],
  };

  const cases: Array<{ name: string; query: string; want: boolean }> = [
    { name: 'matches a pre-hook', query: 'direnv', want: true },
    { name: 'matches deep inside a pre-hook', query: 'sso', want: true },
    { name: 'matches a post-hook', query: 'kubectl', want: true },
    { name: 'matches a second post-hook', query: 'ready', want: true },
    { name: 'label plus hook token', query: 'tilt kubectl', want: true },
    { name: 'hook token from each list', query: 'direnv kubectl', want: true },
    { name: 'still rejects unrelated tokens', query: 'helm', want: false },
  ];

  for (const tc of cases) {
    it(tc.name, () => expect(matchesQuery(withHooks, tc.query)).toBe(tc.want));
  }

  it('ranks a hook match below a command-body match', () => {
    const hookOnly = scoreCommand({ label: 'A', command: 'x', preCommands: ['deploy'] }, ['deploy']);
    const inCommand = scoreCommand({ label: 'A', command: 'deploy' }, ['deploy']);
    const inLabel = scoreCommand({ label: 'Deploy', command: 'x' }, ['deploy']);
    expect(hookOnly).toBeGreaterThan(0);
    expect(inCommand).toBeGreaterThanOrEqual(hookOnly);
    expect(inLabel).toBeGreaterThan(hookOnly);
  });

  it('tolerates missing and malformed hook entries', () => {
    const cases: Searchable[] = [
      { label: 'A', command: 'x' },
      { label: 'A', command: 'x', preCommands: [] },
      { label: 'A', command: 'x', postCommands: [] },
      { label: 'A', command: 'x', postCommands: [{ command: '' }] },
    ];
    for (const c of cases) {
      expect(matchesQuery(c, 'deploy')).toBe(false);
      expect(matchesQuery(c, 'a')).toBe(true);
    }
  });

  it('finds hook matches through global search', () => {
    const projects = [{ id: 'gc', name: 'Giftcards', commands: [withHooks] }];
    const got = searchAllProjects(projects, 'direnv');
    expect(got).toHaveLength(1);
    expect(got[0].cmd.label).toBe('Tilt');
  });
});

describe('hasHooks', () => {
  const cases: Array<{ name: string; cmd: Searchable; want: boolean }> = [
    { name: 'no hook fields', cmd: { label: 'A', command: 'x' }, want: false },
    { name: 'empty arrays', cmd: { label: 'A', command: 'x', preCommands: [], postCommands: [] }, want: false },
    { name: 'has pre-hook', cmd: { label: 'A', command: 'x', preCommands: ['y'] }, want: true },
    { name: 'has post-hook', cmd: { label: 'A', command: 'x', postCommands: [{ command: 'y' }] }, want: true },
  ];

  for (const tc of cases) {
    it(tc.name, () => expect(hasHooks(tc.cmd)).toBe(tc.want));
  }
});
