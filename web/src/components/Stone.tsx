import type { StoneColor } from '@arena/shared';

interface StoneProps {
  color: StoneColor;
  last?: boolean;
  preview?: boolean;
  /** Go scoring: the block this stone belongs to is marked dead. */
  dead?: boolean;
}

/** A single stone. Purely presentational: the board owns the interaction. */
export function Stone({
  color,
  last = false,
  preview = false,
  dead = false,
}: StoneProps) {
  const className = [
    'stone',
    `stone--${color}`,
    last ? 'stone--last' : '',
    preview ? 'stone--preview' : '',
    dead ? 'stone--dead' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return <span className={className} aria-hidden="true" />;
}
