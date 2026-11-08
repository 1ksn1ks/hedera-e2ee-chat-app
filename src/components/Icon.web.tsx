// Browser preview: the shared icon shapes as a plain DOM <svg>. The
// pre-bundled react-native-svg takes its native render path in Vite and
// cannot draw in a browser, so the web build never imports it.
import React from 'react';
import { ICONS, type IconProps } from './iconShapes';

export type { IconName } from './iconShapes';

export function Icon({ name, size = 20, color, strokeWidth = 2 }: IconProps) {
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: color,
      strokeWidth,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
      style: { display: 'block', flexShrink: 0, pointerEvents: 'none' },
    },
    ICONS[name].map((s, i) => {
      const { t, ...attrs } = s;
      return React.createElement(t, { key: i, ...attrs });
    })
  );
}
