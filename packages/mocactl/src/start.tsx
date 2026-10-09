import { render } from 'ink';
import { App } from './app.js';
import type { InteractiveOptions } from './cli.js';
import { realOs } from './os.js';
import type { Runtime } from './runtime.js';

export async function startInteractive(rt: Runtime, opts: InteractiveOptions): Promise<number> {
  const instance = render(
    <App
      rt={rt}
      opts={opts}
      env={process.env}
      os={realOs()}
      write={(s) => void process.stdout.write(s)}
    />,
    // Ctrl+C is the App's: with a detachable turn running it asks first (turn-reattach spec §6.3).
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
  return 0;
}
