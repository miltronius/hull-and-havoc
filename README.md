# Hull & Havoc

A browser-based naval combat and ship-building game. Build a ship block by
block in the shipyard, then sail it into battle against an AI enemy. Put enough
ballast tanks in it and the same ship becomes a submarine.

There is no hull-integrity bar anywhere in the game. Buoyancy *is* the health
system: shells knock individual blocks out of the hull, which costs you lift
and mass directly, shifts your centre of gravity, and eventually sinks you.
Heel past your stability limit and water starts coming in, which costs more
buoyancy, which makes you list further — recoverable only by levelling out, and
only while your engines survive, because the engines are also the pumps.

```bash
pnpm install
pnpm dev      # http://localhost:5173 — the Network URL it prints works on a phone
pnpm check    # typecheck + lint + 113 tests
```

## Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Throttle / steer | `W` `S` / `A` `D` | left joystick |
| Depth | `Q` `E` | Dive / Rise |
| Trim (dive planes) | `I` `K` `J` `L` | trim pad |
| Auto-depth toggle | `H` | AUTO |
| Fire / torpedo | `Space` / `T` | Fire / Torp |
| Elevation / traverse | `↑` `↓` / `←` `→` | sliders |
| Gun power | `[` `]` | slider |
| Camera | drag, scroll | drag, pinch |

Cannons only fire at or near the surface; torpedoes only launch once you are
properly under. A hull with both has to change depth mid-fight to use both.

## Layout

- `src/engine/` — the simulation. Vanilla, imperative, and runnable in Node
  with no browser, which is how the physics is tested.
- `src/ui/` — the HUD. Plain DOM today, React next.
- `legacy/hull-and-havoc-v3.html` — the original single-file prototype, frozen.
  The parity tests slice functions out of it and run them against the port.
- `tests/` — 113 headless tests, including regressions for every physics bug
  that was found the hard way during the prototype.

See [CLAUDE.md](CLAUDE.md) for architecture, the physics pitfalls that must not
be reintroduced, and the roadmap.
