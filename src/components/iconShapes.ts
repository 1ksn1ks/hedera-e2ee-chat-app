// Line icons on a 24px grid (2px stroke, round caps). One list of shapes,
// drawn by Icon.tsx (react-native-svg, phones) and Icon.web.tsx (DOM svg).

export type IconName =
  | 'back'
  | 'chevron'
  | 'lock'
  | 'send'
  | 'plus'
  | 'check'
  | 'x'
  | 'pencil'
  | 'users'
  | 'wallet'
  | 'key'
  | 'hash'
  | 'server'
  | 'globe';

export type IconShape =
  | { t: 'path'; d: string }
  | { t: 'rect'; x: number; y: number; width: number; height: number; rx: number }
  | { t: 'circle'; cx: number; cy: number; r: number };

export interface IconProps {
  name: IconName;
  size?: number;
  color: string;
  strokeWidth?: number;
}

const p = (d: string): IconShape => ({ t: 'path', d });

export const ICONS: Record<IconName, IconShape[]> = {
  back: [p('m15 18-6-6 6-6')],
  chevron: [p('m9 18 6-6-6-6')],
  lock: [{ t: 'rect', x: 4, y: 11, width: 16, height: 10, rx: 2 }, p('M8 11V7a4 4 0 0 1 8 0v4')],
  send: [p('M12 19V5'), p('m5 12 7-7 7 7')],
  plus: [p('M12 5v14'), p('M5 12h14')],
  check: [p('M20 6 9 17l-5-5')],
  x: [p('M18 6 6 18'), p('m6 6 12 12')],
  pencil: [p('M12 20h9'), p('M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z')],
  users: [
    p('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2'),
    { t: 'circle', cx: 9, cy: 7, r: 4 },
    p('M22 21v-2a4 4 0 0 0-3-3.87'),
    p('M16 3.13a4 4 0 0 1 0 7.75'),
  ],
  wallet: [{ t: 'rect', x: 3, y: 6, width: 18, height: 14, rx: 2 }, p('M3 10h18'), p('M16 15h2')],
  key: [{ t: 'circle', cx: 7.5, cy: 15.5, r: 4.5 }, p('m10.7 12.3 9.3-9.3'), p('m17 6 2.5 2.5'), p('m14.5 8.5 2 2')],
  hash: [p('M4 9h16'), p('M4 15h16'), p('M10 3 8 21'), p('m16 3-2 18')],
  server: [
    { t: 'rect', x: 3, y: 4, width: 18, height: 7, rx: 2 },
    { t: 'rect', x: 3, y: 13, width: 18, height: 7, rx: 2 },
    p('M7 7.5h.01'),
    p('M7 16.5h.01'),
  ],
  globe: [{ t: 'circle', cx: 12, cy: 12, r: 9 }, p('M3 12h18'), p('M12 3a14 14 0 0 1 0 18'), p('M12 3a14 14 0 0 0 0 18')],
};
