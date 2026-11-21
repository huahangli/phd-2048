# PhD 2048

This repository is a fork of [PhD 2048 by ymfa](https://github.com/ymfa/phd-2048),
which adapts [Gabriele Cirulli's original 2048](https://github.com/gabrielecirulli/2048)
for PhD students. [Play ymfa's version](https://ymfa.github.io/phd-2048/).

**[Play this version on GitHub Pages](https://huahangli.github.io/phd-2048/)**.
The hosted game supports keyboard and touch input and the browser-based
automatic strategies. Use the local server below for model control and JSONL replay.

### Demo

Expectimax reaches the PhD tile in this sped-up recording. The Activity
Monitor panel shows system-wide CPU usage from a separate gameplay run.

https://github.com/user-attachments/assets/0e30f6fc-e24a-4a86-bcb4-baf9a233ff2e

### Forking
Feel free to fork and create your own version of 2048. A few suggestions on what to fiddle with:

- Change tile names in `html_actuator.js`;
- Change game description in `index.html`;
- Change the detection of user's preferred language in `application.js` (if not required, remove the detection code and `i18n.js`);
- Update `i18n.js` with your changes (`i18n.js` is a later addition that implements a language switch - the game should be able to run without it);
- Change screenshots and icons in `meta/`;
- Change the `appID` and choose when to prompt a mobile user to add this web app to their home screen, near `addToHomescreen` in `index.html`.

As with [the original 2048](https://github.com/gabrielecirulli/2048/blob/master/CONTRIBUTING.md), the `master` branch contains the complete game except for sharing features, analytics, etc., which are not transferrable to a fork.
Therefore you should use the `master` branch rather than `gh-pages`, and add your own sharing and tracking code as appropriate.

### Known issues
- I have to make changes directly to `main.css` instead of `main.scss`, because compiling the original `main.scss` does not reproduce the original `main.css`.

### License
PhD 2048 is licensed under the [GNU General Public License](https://github.com/ymfa/phd-2048/blob/master/LICENSE.txt).

### Run locally

Start the game and its local trajectory server with Python 3.

```sh
python3 serve.py
```

Open <http://127.0.0.1:2048/>, pick a strategy, and click **新开轨迹**.
Immediate-score greedy, one-step board evaluation, and the Expectimax
modes run in the browser and continue past 2048. They use the local
server to save moves.

### Model control

- Open [Jev](http://127.0.0.1:2048/?strategy=jev) and click **启动 Jev** to
  start a TypeSafe run. Set
  `TYPESAFE_API_KEY` on the server or place the key on one line in the
  ignored local `API_KEYS` file.
- Open [LLM as Control](http://127.0.0.1:2048/?strategy=llm) and click
  **启动 LLM** to use an
  OpenAI-compatible Chat Completions endpoint. 
  If the endpoint requires authentication, set `LLM_API_KEY` in the
  server environment before starting `serve.py`.

The loopback controller API uses these routes. The game exposes its
starting state with `window.game.serialize()` and legal directions with
`window.game.availableDirections()` in `up, right, down, left` order
(indices 0 to 3).

| Request | JSON fields or result |
|---|---|
| `POST /api/runs` | `state`, `strategy` (`jev` or `llm`). Returns `id` and `revision`. |
| `POST /api/runs/<id>/decision` | `revision`, current `state`, legal `candidates`. Returns `direction` and the next `revision`. |
| `POST /api/runs/<id>/result` | The decision's `revision`, resulting `state`, and `status` (`applied`, `no-op`, `stale`, or `paused`). Save this before requesting the next move. |
| `GET /api/runs/<id>` | Returns the run's stored events. |

The server validates the model answer against the supplied candidates,
and the browser rechecks the board before playing. A single legal
direction is applied locally. The JSONL records the model request and
result, with authentication handled separately by the server.

