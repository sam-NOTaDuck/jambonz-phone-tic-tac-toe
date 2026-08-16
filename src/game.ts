/**
 * game.ts — shared tic-tac-toe state machine and helpers.
 *
 * Game state lives in a module-level Map keyed by a short random id, so that two
 * separate Jambonz WebSocket sessions (Player X and Player O) can reach into the
 * same room object and drive verbs on either leg directly.
 */
import { randomUUID } from 'crypto';
import type { Session } from '@jambonz/sdk/websocket';

export type Player = 'X' | 'O';
export type Cell = '' | 'X' | 'O';
export type Status = 'waiting' | 'in_progress' | 'over';

export interface Game {
  id: string;
  board: Cell[];
  turn: Player;
  status: Status;
  /** Live session references for each leg, held so either can be driven directly. */
  sessions: { X?: Session; O?: Session };
  /** callSid recorded for logging / hangup bookkeeping. */
  callSids: { X?: string; O?: string };
  /** Tracks which players have already been pushed into a move gather, to avoid
   *  double-starting a leg when an O-join redirect and a stale lobby timeout race. */
  activated: Set<Player>;
  /** True once the app has ended the game (win/draw) and hung both legs up, so the
   *  close handler knows not to send a duplicate "player left" notice. */
  ended: boolean;
}

/** All active games, keyed by game id. */
export const games = new Map<string, Game>();

export function createGame(): Game {
  const id = randomUUID();
  const game: Game = {
    id,
    board: ['', '', '', '', '', '', '', '', ''],
    turn: 'X',
    status: 'waiting',
    sessions: {},
    callSids: {},
    activated: new Set<Player>(),
    ended: false,
  };
  games.set(id, game);
  return game;
}

/** Find a game that is still waiting for an opponent (Player O). */
export function findWaitingGame(): Game | undefined {
  for (const g of games.values()) {
    if (g.status === 'waiting') return g;
  }
  return undefined;
}

export function deleteGame(id: string): void {
  games.delete(id);
}

const WIN_LINES: number[][] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
];

export function checkWinner(board: Cell[]): Player | null {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a] as Player;
    }
  }
  return null;
}

/** Return the winning line's cell indices (e.g. [0, 1, 2] for the top row), or null. */
export function getWinningLine(board: Cell[]): number[] | null {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return line;
    }
  }
  return null;
}

export function isBoardFull(board: Cell[]): boolean {
  return board.every((cell) => cell !== '');
}

export const NUMBER_WORDS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
];

/** Describe a single square for TTS, e.g. "X in square five." or "Empty square three." */
export function cellWord(cell: Cell, index: number): string {
  const pos = NUMBER_WORDS[index];
  if (cell === '') return `Empty square ${pos}.`;
  return `${cell} in square ${pos}.`;
}

/** Full board readout, all nine squares left-to-right, top-to-bottom. */
export function boardReadout(board: Cell[]): string {
  const parts = board.map((cell, i) => cellWord(cell, i));
  return `The board is: ${parts.join(' ')}`;
}

/** Occupied-only readout: lists just the X/O squares, skips the empty ones. */
export function occupiedReadout(board: Cell[]): string {
  const parts = board
    .map((cell, i) => (cell ? cellWord(cell, i) : null))
    .filter((s): s is string => s !== null);
  if (parts.length === 0) return 'The board is empty.';
  return `The board is: ${parts.join(' ')}`;
}

/** Status of a single square for TTS, e.g. "Square five is X." or "Square five is empty." */
export function squareStatus(board: Cell[], index: number): string {
  const pos = NUMBER_WORDS[index];
  const cell = board[index];
  if (cell === '') return `Square ${pos} is empty.`;
  return `Square ${pos} is ${cell}.`;
}

/** Log helper — every meaningful event is logged with the game id. */
export function log(game: Game | undefined, message: string): void {
  const tag = game ? `game ${game.id.slice(0, 8)}` : 'ttt';
  console.log(`[ttt] [${tag}] ${message}`);
}
