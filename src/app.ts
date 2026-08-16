/**
 * app.ts — Phone Tic-Tac-Toe over Jambonz WebSocket.
 *
 * Two callers dial the same number. Each call is its own WebSocket session.
 * Game state (board, turn, both live session references) lives in a module-level
 * Map keyed by a random game id, shared across both sessions. The app is the only
 * voice the players hear (TTS); input is pure DTMF via the keypad 1-9.
 *
 * Turn transitions drive the *other* leg directly by holding its session reference
 * and calling `.send()` (a redirect command that interrupts that leg's idle pause
 * and starts its move gather). Same-leg actionHook responses always use `.reply()`.
 */
import http from 'http';
import { createEndpoint } from '@jambonz/sdk/websocket';
import type { Session } from '@jambonz/sdk/websocket';
import {
  games, createGame, findWaitingGame, deleteGame,
  checkWinner, getWinningLine, isBoardFull, boardReadout, occupiedReadout, squareStatus, NUMBER_WORDS, log,
  type Game, type Player,
} from './game';

const PORT = 3010;
/** Active player's move gather timeout (seconds). */
const MOVE_TIMEOUT = 15;
/** Lobby wait gather timeout for Player X (seconds). */
const LOBBY_TIMEOUT = 30;
/** Idle-leg pause length. Long enough that the idle leg stays "on hold" in a
 *  single interruptible pause until the other player moves and re-engages it. */
const IDLE_PAUSE = 120;

/** Payload jambonz delivers to a gather actionHook (WebSocket event). */
interface MoveEvent {
  reason?: string;
  /** DTMF digits collected. The schema field is `digits`; `dtmf` is accepted too. */
  dtmf?: string;
  digits?: string;
}

/* ------------------------------------------------------------------ helpers */

function otherPlayer(p: Player): Player {
  return p === 'X' ? 'O' : 'X';
}

/** Build a move gather (DTMF, 1 digit, /move hook) with the given spoken prompt. */
function queueMoveGather(session: Session, prompt: string): Session {
  return session.gather({
    input: ['digits'],
    numDigits: 1,
    timeout: MOVE_TIMEOUT,
    actionHook: '/move',
    say: { text: prompt },
  });
}

/** Build the lobby wait gather for Player X. Uses its own `/lobby` actionHook so
 *  lobby timeout/keypress events can never be confused with an in-game `/move`
 *  event (e.g. when O joins and redirects X into the move gather at the same time
 *  the lobby gather fires). */
function queueLobbyGather(session: Session, prompt: string): Session {
  return session.gather({
    input: ['digits'],
    numDigits: 1,
    timeout: LOBBY_TIMEOUT,
    actionHook: '/lobby',
    say: { text: prompt },
  });
}

/** Put a leg on idle hold: a long, silent pause (no gather, so it accepts no move
 *  and produces no chatter). Interruptible by a `.send()` redirect when its turn comes. */
function queueIdle(session: Session): Session {
  return session.pause({ length: IDLE_PAUSE });
}

/* --------------------------------------------------------------- matchmaking */

/** Caller 1: no open game → create one and become Player X, then wait in the lobby. */
function createAsX(session: Session): void {
  const game = createGame();
  game.sessions.X = session;
  game.callSids.X = session.callSid;
  session.locals.gameId = game.id;
  session.locals.symbol = 'X';
  log(game, 'game created');
  log(game, `X joined ${session.callSid}`);
  registerSessionHandlers(session);

  session
    .say({ text: 'Welcome to phone tic tac toe. You are Player X. Waiting for Player O to call in. Please hold. Press star at any time to hear the current board.' })
    .gather({ input: ['digits'], numDigits: 1, timeout: LOBBY_TIMEOUT, actionHook: '/lobby' })
    .send();
}

/** Caller 2: a game is waiting → become Player O and start the game. */
function joinAsO(game: Game, session: Session): void {
  game.sessions.O = session;
  game.callSids.O = session.callSid;
  session.locals.gameId = game.id;
  session.locals.symbol = 'O';
  log(game, `O joined ${session.callSid}`);

  game.status = 'in_progress';
  game.turn = 'X';
  registerSessionHandlers(session);

  // Player O hears the join announcement, then goes on idle hold (X moves first).
  session
    .say({ text: 'Player O has joined. The game begins. Player X goes first. Press star at any time to hear the current board.' })
    .pause({ length: IDLE_PAUSE })
    .send();

  // Player X is notified immediately via its stored session reference: a redirect
  // (.send()) interrupts X's lobby gather and starts X's first move gather.
  const xSession = game.sessions.X;
  if (xSession) {
    game.activated.add('X');
    try {
      xSession
        .gather({
          input: ['digits'],
          numDigits: 1,
          timeout: MOVE_TIMEOUT,
          actionHook: '/move',
          say: { text: 'Your opponent has joined. The game begins. You are X. Press a number, one through nine, to place your X. Press star to hear the board at any time.' },
        })
        .send();
    } catch (err) {
      // X may already be closing; the close handler will clean up and notify O.
      log(game, `X redirect failed on O-join: ${(err as Error).message}`);
    }
  }
}

/** Caller 3+ while a game is in progress or over → reject as full. */
function rejectFull(session: Session): void {
  log(undefined, `call ${session.callSid} rejected (game full)`);
  session
    .say({ text: 'Sorry, this game is full. Goodbye.' })
    .hangup()
    .send();
}

/* ------------------------------------------------------------- move handling */

/** Process a DTMF move digit on the current player's leg (it is this player's turn). */
function handleMove(game: Game, session: Session, symbol: Player, digit: string): void {
  log(game, `move: ${digit} by ${symbol} -> board ${game.board.join('')}`);

  // 0 or * → read the occupied squares only, then re-gather for the move.
  if (digit === '0' || digit === '*') {
    queueMoveGather(session, `${occupiedReadout(game.board)} ${symbol}, your move. Press a number one through nine.`).reply();
    return;
  }
  // # → square-status query: prompt for a square, then report its state (via /query hook).
  if (digit === '#') {
    session
      .gather({
        input: ['digits'],
        numDigits: 1,
        timeout: MOVE_TIMEOUT,
        actionHook: '/query',
        say: { text: 'Press a number, one through nine, to check that square.' },
      })
      .reply();
    return;
  }

  const n = Number(digit);
  if (n >= 1 && n <= 9) {
    const idx = n - 1;
    if (game.board[idx] !== '') {
      queueMoveGather(session, 'That square is taken. Press an empty square, one through nine.').reply();
      return;
    }
    game.board[idx] = symbol;

    const winner = checkWinner(game.board);
    if (winner) {
      endGameWin(game, winner, session);
      return;
    }
    if (isBoardFull(game.board)) {
      endGameDraw(game, session);
      return;
    }

    // Continue: switch turn.
    game.turn = otherPlayer(symbol);
    const lastMove = `${symbol} placed in square ${NUMBER_WORDS[idx]}.`;
    // Player who just moved → brief notice + idle hold (via .reply on their own hook).
    session
      .say({ text: `Player ${game.turn} is up. ${lastMove}` })
      .pause({ length: IDLE_PAUSE })
      .reply();
    // Next player → move gather (via .send redirect on their stored session).
    const nextSession = game.sessions[game.turn];
    if (nextSession) {
      game.activated.add(game.turn);
      try {
        queueMoveGather(nextSession, `Your move, ${game.turn}. ${lastMove} Press a number, one through nine.`).send();
      } catch (err) {
        log(game, `${game.turn} redirect failed on turn switch: ${(err as Error).message}`);
      }
    }
    return;
  }

  // Any other single digit (none expected with numDigits:1) → re-prompt.
  queueMoveGather(session, `Press a number, one through nine, to place your ${symbol}.`).reply();
}

/** A player wins: announce the result to both legs, then hang both up. */
function endGameWin(game: Game, winner: Player, session: Session): void {
  game.status = 'over';
  game.ended = true;
  log(game, `over: ${winner}`);
  const line = getWinningLine(game.board) ?? [];
  const winSquares = line.map((i) => `square ${NUMBER_WORDS[i]}`).join(', ');
  const message = `${boardReadout(game.board)} Player ${winner} wins with ${winSquares}! Congratulations. Thanks for playing. Call back anytime for a rematch.`;

  // Winner (the leg that just moved) — reply to its /move hook.
  session.say({ text: message }).hangup().reply();
  // Loser — redirect its idle pause into the announcement + hangup.
  const loser = otherPlayer(winner);
  const loserSession = game.sessions[loser];
  if (loserSession) {
    try {
      loserSession.say({ text: message }).hangup().send();
    } catch (err) {
      log(game, `${loser} end-game redirect failed: ${(err as Error).message}`);
    }
  }
  // Do NOT delete here: keep status 'over' in the map until both legs close so a
  // third caller during the hang-up window still gets the "full" treatment. The
  // close handlers delete the game once a leg disconnects.
}

/** Board full, no winner: announce the draw to both legs, then hang both up. */
function endGameDraw(game: Game, session: Session): void {
  game.status = 'over';
  game.ended = true;
  log(game, 'over: draw');
  const message = "The game is a draw. Cat's game. Thanks for playing. Call back anytime for a rematch.";

  session.say({ text: message }).hangup().reply();
  const other = otherPlayer(session.locals.symbol as Player);
  const otherSession = game.sessions[other];
  if (otherSession) {
    try {
      otherSession.say({ text: message }).hangup().send();
    } catch (err) {
      log(game, `${other} end-game redirect failed: ${(err as Error).message}`);
    }
  }
}

/* ----------------------------------------------------------- event handlers */

/** Dispatch a /lobby actionHook event (only Player X's lobby gather fires this). */
function handleLobbyEvent(session: Session): void {
  const game = games.get(session.locals.gameId as string);
  if (!game) {
    session.hangup().reply();
    return;
  }

  if (game.status === 'waiting') {
    // Still waiting for Player O — re-prompt the lobby gather.
    queueLobbyGather(session, 'Still waiting for Player O. Please hold.').reply();
    return;
  }

  if (game.status === 'over') {
    session.hangup().reply();
    return;
  }

  // status === 'in_progress' → Player O joined while this lobby gather was running.
  // O-join already redirected X into the move gather and marked X activated, so a
  // stale /lobby hook arriving now is acknowledged empty. (If, defensively, X was
  // not yet activated — e.g. the redirect never landed — start the game here.)
  if (game.activated.has('X')) {
    session.reply();
  } else {
    game.activated.add('X');
    queueMoveGather(
      session,
      'Your opponent has joined. The game begins. You are X. Press a number, one through nine, to place your X.',
    ).reply();
  }
}

/** Dispatch a /move actionHook event on a session (in-game turns only). */
function handleMoveEvent(session: Session, evt: MoveEvent): void {
  const game = games.get(session.locals.gameId as string);
  if (!game) {
    session.hangup().reply();
    return;
  }
  const symbol = session.locals.symbol as Player | undefined;
  if (!symbol) {
    session.hangup().reply();
    return;
  }

  // A /move should only fire while a game is in progress. Defensive fallbacks:
  if (game.status === 'waiting') {
    queueLobbyGather(session, 'Still waiting for Player O. Please hold.').reply();
    return;
  }
  if (game.status === 'over') {
    session.hangup().reply();
    return;
  }

  const reason = String(evt?.reason ?? '');

  // in_progress
  if (game.turn !== symbol) {
    // Not this player's turn. The idle leg is in a pause (no gather), so reaching
    // here is a rare stray event — just put it back on idle hold silently.
    queueIdle(session).reply();
    return;
  }

  // It is this player's turn.
  if (reason === 'dtmfDetected') {
    const digit = String(evt?.dtmf ?? evt?.digits ?? '');
    handleMove(game, session, symbol, digit);
  } else if (reason === 'timeout') {
    queueMoveGather(session, `Still your turn, ${symbol}. Press a number one through nine.`).reply();
  } else {
    // hangup / error / unknown — wind this leg down.
    session.hangup().reply();
  }
}

/** Dispatch a /query actionHook event (square-status query after #). */
function handleQueryEvent(session: Session, evt: MoveEvent): void {
  const game = games.get(session.locals.gameId as string);
  if (!game) {
    session.hangup().reply();
    return;
  }
  const symbol = session.locals.symbol as Player | undefined;
  if (!symbol) {
    session.hangup().reply();
    return;
  }

  const reason = String(evt?.reason ?? '');

  if (reason === 'dtmfDetected') {
    const digit = String(evt?.dtmf ?? evt?.digits ?? '');
    const n = Number(digit);
    if (n >= 1 && n <= 9) {
      // Report the square, then return to the move gather.
      queueMoveGather(session, `${squareStatus(game.board, n - 1)} Your move, ${symbol}. Press a number one through nine.`).reply();
      return;
    }
    // Not a valid square — re-prompt the query.
    session
      .gather({
        input: ['digits'],
        numDigits: 1,
        timeout: MOVE_TIMEOUT,
        actionHook: '/query',
        say: { text: 'That is not a square. Press a number, one through nine, to check that square.' },
      })
      .reply();
    return;
  }

  if (reason === 'timeout') {
    queueMoveGather(session, `Still your turn, ${symbol}. Press a number one through nine.`).reply();
    return;
  }

  // hangup / error / unknown — wind this leg down.
  session.hangup().reply();
}

/** Handle a leg closing (hang-up or disconnect). */
function handleClose(session: Session): void {
  const callSid = session.callSid;
  log(undefined, `call ended ${callSid}`);

  const gameId = session.locals.gameId as string | undefined;
  const symbol = session.locals.symbol as Player | undefined;
  if (!gameId || !symbol) return;

  const game = games.get(gameId);
  if (!game) return; // already cleaned up (e.g. end-game hang-ups)

  // An app-initiated end-game (win/draw) already notified both legs; just clean up.
  if (game.ended) {
    deleteGame(game.id);
    return;
  }

  // A player left mid-game (or while waiting). If the other is still connected and
  // the game had started, tell them and hang them up.
  if (game.status === 'in_progress') {
    const other = otherPlayer(symbol);
    const otherSession = game.sessions[other];
    if (otherSession) {
      try {
        otherSession
          .say({ text: `Player ${symbol} has left the game. Game over. Goodbye.` })
          .hangup()
          .send();
      } catch (err) {
        // The other session may already be closing — swallow it.
        log(game, `${other} notify-on-leave failed: ${(err as Error).message}`);
      }
    }
  }
  // status === 'waiting' (X left the lobby): just remove the game, no one to notify.
  deleteGame(game.id);
}

/** Bind the /move and close handlers for a leg. Every handler body is try-caught. */
function registerSessionHandlers(session: Session): void {
  session.on('/lobby', () => {
    try {
      handleLobbyEvent(session);
    } catch (err) {
      console.error(`[ttt] /lobby handler error (call ${session.callSid}):`, err);
      try {
        session.hangup().reply();
      } catch {
        /* ignore */
      }
    }
  });

  session.on('/move', (evt: MoveEvent) => {
    try {
      handleMoveEvent(session, evt);
    } catch (err) {
      console.error(`[ttt] /move handler error (call ${session.callSid}):`, err);
      try {
        session.hangup().reply();
      } catch {
        /* ignore */
      }
    }
  });

  session.on('/query', (evt: MoveEvent) => {
    try {
      handleQueryEvent(session, evt);
    } catch (err) {
      console.error(`[ttt] /query handler error (call ${session.callSid}):`, err);
      try {
        session.hangup().reply();
      } catch {
        /* ignore */
      }
    }
  });

  session.on('close', (code: number, _reason: unknown) => {
    try {
      handleClose(session);
    } catch (err) {
      console.error(`[ttt] close handler error (call ${session.callSid}):`, err);
    }
  });

  session.on('error', (err: Error) => {
    console.error(`[ttt] session error (call ${session.callSid}):`, err);
  });
}

/* -------------------------------------------------------------- entry point */

const server = http.createServer();
const makeService = createEndpoint({ server, envVars: {} });
const svc = makeService({ path: '/' });

svc.on('session:new', (session: Session) => {
  try {
    const waiting = findWaitingGame();
    if (waiting) {
      joinAsO(waiting, session);
      return;
    }
    const busy = Array.from(games.values()).some(
      (g) => g.status === 'in_progress' || g.status === 'over',
    );
    if (busy) {
      rejectFull(session);
      return;
    }
    createAsX(session);
  } catch (err) {
    console.error('[ttt] session:new error:', err);
    try {
      session.hangup().send();
    } catch {
      /* ignore */
    }
  }
});

server.listen(PORT, () => {
  console.log(`Phone Tic-Tac-Toe listening on port ${PORT}`);
});
