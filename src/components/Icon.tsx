// Phones: the shared icon shapes drawn with react-native-svg. The browser
// preview uses Icon.web.tsx (plain DOM svg) instead.
import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { ICONS, type IconProps } from './iconShapes';

export type { IconName } from './iconShapes';

export function Icon({ name, size = 20, color, strokeWidth = 2 }: IconProps) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      pointerEvents="none"
    >
      {ICONS[name].map((s, i) => {
        if (s.t === 'path') return <Path key={i} d={s.d} />;
        if (s.t === 'rect') return <Rect key={i} x={s.x} y={s.y} width={s.width} height={s.height} rx={s.rx} />;
        return <Circle key={i} cx={s.cx} cy={s.cy} r={s.r} />;
      })}
    </Svg>
  );
}
