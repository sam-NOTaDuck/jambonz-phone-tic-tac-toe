# TASK: Build "Phone Tic-Tac-Toe" — a Jambonz voice app (brand new project)

Build a complete, working Jambonz WebSocket voice application from scratch in this
directory. Two people call the SAME phone number from separate phones and play
tic-tac-toe against each other using their phone keypads. The app is the moderator:
it announces the game, enforces turns, reads the board aloud, detects wins/draws,
and handles players hanging up.

## Non-negotiable architecture decisions (already made — do not redesign)

1. **App-only voice.** The two players DO NOT hear each other live. There is NO
   `conference` verb. The app (TTS) is the only voice they hear. (Jambonz conference
   has no per-participant DTMF gather, so live audio + keypad turns don't mix.)
2. **DTMF-only input.** No speech recognition (STT), no LLM, no AI. Pure
   `gather({ input: ['dtmf'] })` + `say()` TTS. Deterministic state machine.
3. **Keypad = board.** Telephone keypad maps 1:1 to the 3x3 grid:
   ```
   1 2 3
   4 5 6
   7 8 9
   ```
   "Press 5" = center square. No translation layer needed.
4. **Each call is its own WebSocket session.** In the jambonz WebSocket SDK, every
   incoming call fires `session:new` on the service. Player X and Player O are TWO
   separate `session` objects on the same server. Game state (board, turn, player
   assignments, and the two live session references) must live in a module-level
   `Map` keyed by a game id, shared across both sessions. Do NOT try to make one
   session control the other via the platform — hold both session references in the
   room object and send verbs to either directly.
5. **Portal-configured TTS.** Do NOT call `.config({ synthesizer: ... })` and do NOT
   pass `synthesizer` in `say()` — the Jambonz portal application will have Google
   TTS configured at the app level (speech_synthesis_vendor, voice, label). Adding a
   synthesizer overrides portal settings and can drop the voice field → silence.
   No recognizer is needed at all (DTMF only), so skip `.config()` entirely.
6. **No env vars required.** The app declares `envVars: {}` in `createEndpoint`.
   No API keys, no LLM. Keep it that way.

## Project scaffold (create in THIS directory)

```
npm init -y
npm install @jambonz/sdk
npm install -D typescript @types/node tsx
```

tsconfig.json: target ES2022, module commonjs, strict true, esModuleInterop true,
skipLibCheck true (REQUIRED — the SDK types reference internal modules), outDir
./dist, rootDir ./src, types ["node"].

package.json scripts: `"build": "tsc"`, `"start": "tsx src/app.ts"`.

## App behavior spec

### Matchmaking (lobby)
- Caller 1 arrives, no open game → creates game id, becomes **Player X**.
  - TTS: "Welcome to phone tic tac toe. You are Player X. Waiting for Player O to
    call in. Please hold." Then wait (a long `gather` with `input: ['dtmf']` and a
    30s timeout, re-prompting every timeout: "Still waiting for Player O. Please hold.")
  - The waiting leg's gather handler must check: did Player O join while we waited?
- Caller 2 arrives while a game is `waiting` → becomes **Player O**, game starts.
  - TTS to O: "Player O has joined. The game begins. Player X goes first."
  - TTS to X (via the stored session reference): "Your opponent has joined. The game
    begins. You are X. Press a number, one through nine, to place your X."
- Caller 3 arrives while a game is `in_progress` → TTS "Sorry, this game is full.
  Goodbye." then `hangup()`.
- Caller arrives while a game is `over` (players still connected, see Rematch) →
  same "full" treatment.
- If a waiting Player X hangs up before O joins → delete the game from the map,
  no one to notify.

### Turns (the core loop)
- Module state: `board` = array of 9 cells ('', 'X', 'O'), `turn` = 'X' | 'O',
  `status` = 'waiting' | 'in_progress' | 'over'.
- Current player's leg: `gather({ input: ['dtmf'], numDigits: 1, timeout: 15,
  actionHook: '/move', say: { text: "Your move, {symbol}. Press a number, one
  through nine." } })`.
- Other player's leg: on their session, send a short `say` + a NON-blocking hold —
  simplest: `say({ text: "Player {X/O} is thinking." })` followed by a `gather` with
  a long timeout and no prompt (or `pause` then nothing). The key requirement: the
  non-active player's leg must NOT accept a move and must not generate an endless
  stream of chatter. Recommended: send `pause` (e.g. 10s) + no gather on the idle
  leg, and rely on the active player's move handler to re-engage both legs. On each
  turn switch, send the new prompt to the new current player.
- IMPORTANT: use `.send()` only for the initial verb array in `session:new`. Every
  actionHook response (including `/move`, lobby re-prompts, hangup notices) MUST use
  `.reply()`.

### Move handling (actionHook `/move`, on the current player's session)
- `evt.dtmf` contains the digit. `evt.reason` for a dtmf gather will be 'dtmfDetected'
  (handle it), 'timeout' (re-prompt: "Still your turn, {symbol}. Press a number one
  through nine."), or others (hangup etc. — wrap up).
- Digit 0, *, or # → read the board (see Board readout), then re-gather for the move.
- Digit 1–9 (index `digit - 1`):
  - Cell occupied → TTS "That square is taken. Press an empty square, one through
    nine." then re-gather.
  - Cell free → place symbol, check win/draw:
    - **Win** (any row, column, or diagonal of the same symbol): TTS board readout +
      "Player {X/O} wins! Congratulations. Thanks for playing. Call back anytime for
      a rematch." then `hangup()` on BOTH sessions; delete game from map.
    - **Draw** (board full, no win): TTS "The game is a draw. Cat's game. Thanks for
      playing. Call back anytime for a rematch." then `hangup()` both; delete game.
    - **Continue**: switch `turn`, then:
      - To the player who just moved: `say({ text: "Player {other} is up." })` + idle
        hold (pause).
      - To the next player: `gather` with the "Your move, {symbol}..." prompt.
- Any other digit (none — numDigits 1 restricts to single digits; digits are 0-9,*,#).

### Board readout (used by 0/*/# and after each winning/drawn move)
Announce the 9 squares left-to-right, top-to-bottom, with positions:
"X in square one. Empty square two. O in square three. ..." — always all nine, using
spoken numbers one through nine. Optionally add a prefix "The board is:" and a suffix
telling whose turn when it's a mid-game request: "{X or O}, your move."

### Hangup handling
- `session.on('close')` on either leg: if the game is `in_progress` or `over` and the
  other player is still connected, TTS to the remaining player "Player {X/O} has left
  the game. Game over. Goodbye." then `hangup()` their leg. Delete the game from the
  map. Wrap in try/catch (the other session may already be closing).

### Robustness requirements
- Wrap EVERY async `session.on(...)` handler body in try-catch. Unhandled rejections
  inside EventEmitter handlers crash the whole Node process.
- No rematch in v1 (document as future work in a README note).
- Log meaningful lines: `[ttt] game <id> created`, `[ttt] <X|O> joined <callSid>`,
  `[ttt] move: <digit> by <X|O> -> board <board>`, `[ttt] game <id> over: <winner|draw>`,
  `[ttt] call ended <callSid>`.
- The module-level games Map must be keyed by a short random id (e.g. `crypto.randomUUID()`).

## Verification (must pass before you finish)
1. `npm run build` → `tsc` compiles with zero errors.
2. `npm start` boots and prints a startup line ("Phone Tic-Tac-Toe listening on port
   3010" or similar). The HTTP endpoint should return 405 on plain GET (normal for a
   WebSocket jambonz app).
3. Include a `README.md` describing: how to run, how to provision a Jambonz app to
   point at this WebSocket (wss URL), the keypad map, and the v2 ideas (rematch,
   live conference audio, spectator mode, board readout languages).

## Reference patterns (from our proven jambonz codebase — follow these exactly)

WebSocket entry point:
```typescript
import http from 'http';
import { createEndpoint } from '@jambonz/sdk/websocket';

const server = http.createServer();
const makeService = createEndpoint({ server, port: 3010, envVars: {} });
const svc = makeService({ path: '/' });

svc.on('session:new', (session) => {
  // session.callSid identifies this leg
  // session.say({...}).gather({...}).send();   // initial verbs only
});

// actionHook events: session.on('/move', async (evt) => { ... .reply(); });
// hangup: session.on('close', () => { ... });
```

DTMF gather (the pattern to use everywhere):
```typescript
session.gather({
  input: ['dtmf'],
  numDigits: 1,
  timeout: 15,
  actionHook: '/move',
  say: { text: 'Your move, X. Press a number, one through nine.' },
}).reply();   // in a hook handler
```

## What NOT to do
- Do NOT use the `conference` or `room` verbs.
- Do NOT use `llm`, `s2s`, or any AI/STT integration.
- Do NOT use `.config()`.
- Do NOT use `process.env` for anything.
- Do NOT touch anything outside this directory.
- Do NOT create extra files beyond the project (package.json, tsconfig.json,
  src/app.ts, src/game.ts or similar, README.md, .gitignore).

When done, report: what you built, the file list, that `npm run build` passes, and
any deviations from this spec.
