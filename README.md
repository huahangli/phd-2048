# PhD 2048

This repository is a fork of [PhD 2048 by ymfa](https://github.com/ymfa/phd-2048),
which adapts [Gabriele Cirulli's original 2048](https://github.com/gabrielecirulli/2048)
for PhD students. [Play ymfa's version](https://ymfa.github.io/phd-2048/).

**[Play this version on GitHub Pages](https://huahangli.github.io/phd-2048/)**.
The hosted game supports keyboard and touch input and the browser-based
automatic strategies. Use the local server below for Jev or JSONL replay.

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
server to save moves. Jev mode reads a TypeSafe key from the environment
(`TYPESAFE_API_KEY`) or from a single line in `API_KEYS`.

Edit **走棋间隔（秒）** to set the delay after each turn. It defaults to
0.8 seconds. Set it to 0 to start the next search as soon as the previous
turn is saved. Click **暂停** or make a manual move to take over.

**轨迹回放** lists the runs saved in `jev-runs/<run-id>.jsonl`. Pick a run
and use the step field, slider, or playback controls to inspect its exact
saved positions. **从末尾续跑** restores the latest saved step and appends
to the original file. Each file begins with the initial board and records
the decision, execution outcome, and each resulting board. Local
strategies also save their candidate values when comparing multiple moves.

Run the rule checks and compare local strategies on the same seeded
games with `node tests/local_strategies.cjs 10`. Compare just the two
Expectimax modes with `node tests/local_strategies.cjs 5 expectimax expectimax_deep`.

The deeper mode tries a third move when eight or fewer cells are empty,
using weighted samples for later spawn locations. If it reaches its
search budget, it falls back to the two-move result.

**Expectimax 最多 10 步** runs in a browser worker with a 50 ms search target,
iteratively deepens from one move, and returns its last completed depth.
It considers every spawn location at the root and uses weighted sampling
and at most two ranked directions deeper in the tree. It retains up to
50,000 cached search entries per run. The controls show completed depth,
the latest search time, rolling P95, and cumulative cache hit rate.
The search assumes a 50 ms simulated turn when the real inter-turn delay is
set to 0. The simulated turn length and the configured delay are both
saved in the trace.

For the 50 ms seeded experiment, run
`node tests/local_strategies.cjs 3 expectimax_deep expectimax_10`.
The benchmark uses a virtual 800 ms game clock without sleeping.
