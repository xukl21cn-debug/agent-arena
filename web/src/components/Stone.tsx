import type { StoneColor } from '@gomoku/shared';

interface StoneProps {
  color: StoneColor;
  last?: boolean;
  preview?: boolean;
}

/** A single stone. Purely presentational: the board owns the interaction. */
export function Stone({ color, last = false, preview = false }: StoneProps) {
  const className = [
    'stone',
    `stone--${color}`,
    last ? 'stone--last' : '',
    preview ? 'stone--preview' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return <span className={className} aria-hidden="true" />;
}
