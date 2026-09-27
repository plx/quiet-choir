#!/usr/bin/env node

import { launchCli } from '../src/cli/launch.ts';

await launchCli({ development: true, dir: import.meta.url });
