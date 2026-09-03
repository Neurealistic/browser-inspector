// CEN-55 — thin CLI over the canonical store. Run: npx tsx src/mcp/profile/cli.ts <verb> [args]
// Verbs: list | read <alias> | create-alias <name> --src <s> --browser <b> [--os <os>]
//        copy <from> <to> | delete <alias> | materialize <alias> [--headed]
//        export <alias> [--with-session] > bundle.json | import <bundle.json>
import { readFileSync } from 'fs';
import { list, read, createAlias, copyAlias, deleteAliasAndProfile, exportAlias, importBundle } from './verbs.js';
import { materialize } from './builder.js';
import { clonesRoot } from './store.js';

function flag(args: string[], name: string, def = ''): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

(async () => {
  const [verb, ...args] = process.argv.slice(2);
  switch (verb) {
    case 'list':
      console.log(JSON.stringify(list(), null, 2));
      break;
    case 'read':
      console.log(JSON.stringify(read(args[0]), null, 2));
      break;
    case 'create-alias':
      createAlias(args[0], {
        src: flag(args, 'src'),
        target: { os: (flag(args, 'os', 'darwin')) as any, browser: flag(args, 'browser', 'chromium') },
        overlay: {}, session: null,
      });
      console.log(`created alias ${args[0]}`);
      break;
    case 'copy':
      copyAlias(args[0], args[1]);
      console.log(`copied ${args[0]} → ${args[1]}`);
      break;
    case 'delete':
      deleteAliasAndProfile(args[0], clonesRoot());
      console.log(`deleted alias + profile ${args[0]}`);
      break;
    case 'materialize': {
      const inst = await materialize(args[0], { headless: !args.includes('--headed') });
      console.log(JSON.stringify({ alias: inst.alias, engine: inst.engine, cdpPort: inst.cdpPort, userDataDir: inst.userDataDir }, null, 2));
      if (args.includes('--headed')) { console.log('headed instance up; Ctrl-C to close'); await new Promise(() => {}); }
      else await inst.close();
      break;
    }
    case 'export':
      console.log(JSON.stringify(exportAlias(args[0], args.includes('--with-session')), null, 2));
      break;
    case 'import':
      importBundle(JSON.parse(readFileSync(args[0], 'utf-8')));
      console.log('imported');
      break;
    default:
      console.error('verbs: list | read | create-alias | copy | delete | materialize | export | import');
      process.exit(1);
  }
})().catch(e => { console.error('ERROR:', (e as Error).message); process.exit(1); });
