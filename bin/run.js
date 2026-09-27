#!/usr/bin/env node

import { launchCli } from '../dist/cli/launch.js';

await launchCli({ dir: import.meta.url });
