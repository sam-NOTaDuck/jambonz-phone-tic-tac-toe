# Phone Tic-Tac-Toe (Jambonz WebSocket voice app)

Two people call the **same phone number** from separate phones and play tic-tac-toe
against each other using their telephone keypads. The app is the moderator: it
announces the game, enforces turns, reads the board aloud, detects wins/draws, and
handles players hanging up. The two players never hear each other — the app's TTS
is the only voice they hear.

- **Input:** DTMF only (telephone keypad). No speech recognition, no LLM, no AI.
- **Voice:** TTS only. No `conference`/`room`, no live audio between callers.
- **Each call is its own WebSocket session.** Player X and Player O are two
  separate `session` objects on the same server. Game state (board, turn, player
  assignments, and both live session references) lives in a module-level `Map`
  keyed by a game id, shared across both sessions.

## Keypad map

The telephone keypad maps 1:1 to the 3×3 grid:

```
1 2 3
4 5 6
7 8 9
```

"Press 5" = center square. Keys for board awareness:
- `0` or `*` → **occupied squares only**: reads out the X/O squares and skips the
  empty ones ("The board is: X in square one. O in square three."), then re-prompts
  for the move.
- `#` → **square-status query**: press `#` then a digit 1–9 to ask about that
  square ("Press a number, one through nine, to check that square." →
  "Square five is empty." / "Square five is X."), then returns to the move prompt.

## Project layout

```
package.json        # scripts: build (tsc), start (tsx src/app.ts)
tsconfig.json       # ES2022 / commonjs / strict
src/game.ts         # shared state machine: Game type, games Map, win/draw, board readout
src/app.ts          # Jambonz WebSocket server: matchmaking, turn loop, hooks, hangup
README.md
.gitignore
```

## How to run

```bash
npm install
npm run build   # tsc -> dist/ (zero errors)
npm start       # tsx src/app.ts  -> "Phone Tic-Tac-Toe listening on port 3010"
```

The HTTP server listens on **port 3010**. A plain `GET /` returns **405 Method Not
Allowed** (normal for a WebSocket-only Jambonz endpoint); an `OPTIONS /` returns
`200 {}` (the empty `envVars` schema, since this app needs no configuration).

## Provisioning a Jambonz application

1. Deploy this server somewhere reachable from your Jambonz provider (e.g. a host
   with a public address / TLS-terminating reverse proxy in front of port 3010).
2. In the Jambonz portal, create a new **Application**.
3. Set the application's **call hook** / **WebSocket URL** to the public
   `wss://` URL of this server, e.g. `wss://your-host.example/`.
   - The path is `/` (the app registers `makeService({ path: '/' })`).
   - The server speaks the `ws.jambonz.org` subprotocol (handled by the SDK).
4. Configure **Google TTS** at the **application level** in the portal
   (speech_synthesis_vendor, voice, label). The app deliberately does **not** call
   `.config({ synthesizer })` and does **not** pass a `synthesizer` in `say()`, so
   the portal-level TTS settings (including the voice) are used as-is. Adding a
   synthesizer in code would override portal settings and can drop the voice field.
5. Assign a phone number (DID) to the application. Both players dial that number.
6. No recognizer (STT) is needed — input is DTMF only — so skip STT config entirely.
7. No environment variables are required (`envVars: {}`).

## How a game works

### Matchmaking (lobby)
- **Caller 1** finds no open game → a new game is created, they become **Player X**,
  hear the welcome, and wait in a 30s lobby gather that re-prompts
  *"Still waiting for Player O. Please hold."* on each timeout.
- **Caller 2** arrives while a game is `waiting` → becomes **Player O**, the game
  starts. O hears *"Player O has joined. The game begins. Player X goes first.
  Press star at any time to hear the current board."*
  and is put on hold. X is notified immediately through its stored session
  reference (a redirect that interrupts X's lobby gather) with
  *"Your opponent has joined. The game begins. You are X. Press a number… Press
  star to hear the board at any time."*.
- **Caller 3+** while a game is `in_progress` or `over` → hear *"Sorry, this game
  is full. Goodbye."* and are hung up.
- If a waiting **Player X hangs up before O joins**, the game is deleted; no one
  is notified.

### Lobby hook
Player X's lobby wait gather uses its own `/lobby` actionHook (separate from the
in-game `/move` hook). This keeps a stale lobby timeout/keypress from being
confused with an in-game move when O joins and redirects X into the move gather at
almost the same instant the lobby gather fires. The `/lobby` handler re-prompts the
lobby while still waiting, and — if O has already joined — acknowledges a stale hook
with an empty reply (X was already redirected into the game).

### Turns
- The current player's leg runs a `gather({ input: ['digits'], numDigits: 1,
  timeout: 15, actionHook: '/move', say: { text: "Your move, {symbol}…" } })`.
- The other (idle) player's leg is put on a long silent `pause` (no gather, so it
  accepts no move and produces no chatter). When the turn switches, the active
  player's `/move` handler re-engages both legs: it `.reply()`s to itself
  (*"Player {other} is up."* + idle pause) and `.send()`s a redirect to the other
  leg's stored session to start its move gather.
- `.send()` is used only for the initial verb array in `session:new` and for
  **cross-leg** redirects (driving the *other* leg, which has no pending actionHook
  to reply to). Every actionHook response on the *same* leg uses `.reply()`.

### Move handling (`/move` actionHook)
- `reason: 'dtmfDetected'` with the digit (read from `evt.digits`):
  - `0` / `*` → read the **occupied** squares aloud (skipping empties), then
    re-gather for the move.
  - `#` → enter **square-status query** (see `/query` below).
  - `1`–`9` on an occupied square → *"That square is taken…"* then re-gather.
  - `1`–`9` on an empty square → place the symbol, then:
    - **Win** → board readout + *"Player {X/O} wins with square one, square four,
      square nine! Congratulations. Thanks for playing. Call back anytime for a
      rematch."* (the exact winning squares are spoken) then `hangup()` on **both**
      legs; the game is removed once the legs close.
    - **Draw** (board full, no winner) → *"The game is a draw. Cat's game. Thanks
      for playing…"* then `hangup()` both; remove the game.
    - **Continue** → switch turn, notify the mover (*"Player {other} is up. {X}
      placed in square {n}."* + idle pause) and start the next player's move
      gather (*"Your move, {other}. {X} placed in square {n}. Press a number…"*).
- `reason: 'timeout'` → *"Still your turn, {symbol}. Press a number one through
  nine."* then re-gather.
- Other reasons → wind the leg down.

### Board readout
All nine squares, left-to-right, top-to-bottom, using spoken numbers:
*"The board is: X in square one. Empty square two. O in square three. …"* (used in
the win/draw announcements). The mid-game `0`/`*` readout uses only the occupied
squares: *"The board is: X in square one. O in square three."*

### Square-status query (`/query` actionHook)
Pressing `#` during your turn starts a query gather: *"Press a number, one through
nine, to check that square."* The next digit reports just that square via
`squareStatus()` — *"Square five is empty."* / *"Square five is X."* / *"Square
five is O."* — then returns to the move gather. An invalid digit re-prompts the
query; a timeout returns to the move prompt.

### Hangup handling
On `close` of either leg: if the game is `in_progress` and the other player is
still connected, TTS *"Player {X/O} has left the game. Game over. Goodbye."* then
`hangup()` their leg (wrapped in try/catch), and the game is deleted. App-initiated
end-game hangups (win/draw) are tracked so they don't trigger a duplicate
"player left" notice.

### Robustness
- Every `session.on(...)` handler body is wrapped in try-catch (unhandled
  rejections in EventEmitter handlers would crash the process).
- Module-level `games` Map keyed by `crypto.randomUUID()`.
- Meaningful log lines: `[ttt] game <id> created`, `[ttt] <X|O> joined <callSid>`,
  `[ttt] move: <digit> by <X|O> -> board <board>`, `[ttt] game <id> over: <winner|draw>`,
  `[ttt] call ended <callSid>`.

## Notes / deviations from a strict reading of the spec

- **`input: ['digits']`, not `['dtmf']`.** The `@jambonz/sdk` `gather` schema and
  TypeScript types accept `'speech'` / `'digits'` (the DTMF input type is named
  `'digits'`). The string `'dtmf'` would fail both the TypeScript build and the
  SDK's runtime schema validation. The DTMF *reason* enum value is `'dtmfDetected'`
  (used as shown in the spec).
- **Move digit read from `evt.digits`.** The gather actionHook payload's DTMF field
  is `digits` (per the `@jambonz/schema` gather callback schema). The handler also
  tolerates `evt.dtmf` defensively (`evt.dtmf ?? evt.digits`).
- **Idle leg uses a `pause` (120s) per the spec recommendation**, not a silent
  gather, so the idle leg accepts no move and is cleanly interruptible by the
  cross-leg `.send()` redirect when its turn arrives.
- **Lobby gather uses actionHook `/lobby`** (separate from `/move`) so a stale
  lobby timeout/keypress cannot be misread as an in-game move when O joins and
  redirects X at the same instant. The spec's reference patterns show `/move`
  everywhere; splitting the lobby onto its own hook is a deliberate robustness
  choice that still honors "every actionHook response uses `.reply()`".

## How this was built

Built in one autonomous pass by **Prime Agent** (Prime Intellect's open-source
RLM coding harness, `prime-agent --autonomous --autonomous-gate "npm run build"`)
from a detailed task brief (`TASK.md`, included in this repo), running on
OpenRouter/GLM-5.2. The brief specified the architecture, the Jambonz SDK
patterns, and a `tsc` verification gate; the agent wrote the app, a
31-assertion mock-session integration suite, and this README, and iterated until
the gate passed. Follow-up feature tweaks (winning-square announcements, `*`
board readout hints, last-move turn context) were applied directly by Donna
(Hermes) and verified with live two-phone calls.

## v2 ideas (future work)

- **Rematch.** After a win/draw, offer both players a "press 1 to rematch" prompt
  using a fresh board on the same two legs, instead of hanging up.
- **Live conference audio.** Allow players to hear each other (a `room`/`conference`
  verb) alongside DTMF turns — requires per-participant DTMF gather, which the
  current app-only-voice design avoids.
- **Spectator mode.** A third+ caller could listen to live board readouts as an
  observer instead of being rejected as "full".
- **Board readout languages.** Make the spoken numbers / board phrases
  configurable via a Jambonz application env var (locale) and portal-configured TTS
  voice.
- **Move timeouts / forfeit.** After N move-timeouts, forfeit the stalling player.
