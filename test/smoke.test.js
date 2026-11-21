/**
 * Smoke test for Le Concierge
 * 
 * This is a basic sanity check that ensures the project is properly set up.
 * Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const rootDir = resolve(__dirname, '..');

// Test 1: Project structure exists
test('Project structure exists', async (t) => {
  const requiredPaths = [
    'README.md',
    'AGENTS.md',
    'package.json',
    '.gitignore',
    '.gitattributes',
    'docs/architecture/architecture.yaml',
    'docs/decisions.md',
    'docs/demo.md',
    'server/index.js',
    '.env.example',
    'LICENSE',
    'test/smoke.test.js'
  ];

  for (const path of requiredPaths) {
    await t.test(`File exists: ${path}`, () => {
      const fullPath = resolve(rootDir, path);
      try {
        const stat = statSync(fullPath);
        assert.ok(stat.isFile(), `Path ${path} should be a file`);
      } catch (err) {
        assert.fail(`File ${path} does not exist: ${err.message}`);
      }
    });
  }
});

// Test 1b: Required folders exist
test('Required folders exist', async (t) => {
  const requiredFolders = [
    'server',
    'apps/concierge',
    'apps/resident',
    'vibe-skill',
    'docs/architecture',
    '.github/workflows'
  ];

  for (const folder of requiredFolders) {
    await t.test(`Folder exists: ${folder}`, () => {
      const fullPath = resolve(rootDir, folder);
      try {
        const stat = statSync(fullPath);
        assert.ok(stat.isDirectory(), `Path ${folder} should be a directory`);
      } catch (err) {
        assert.fail(`Folder ${folder} does not exist: ${err.message}`);
      }
    });
  }
});

// Test 2: package.json is valid
test('package.json is valid and has correct properties', async (t) => {
  const pkgPath = resolve(rootDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

  assert.equal(pkg.name, 'le-concierge-vibe', 'Package name should be le-concierge-vibe');
  assert.equal(pkg.version, '0.1.0', 'Version should be 0.1.0');
  assert.ok(pkg.description, 'Should have description');
  assert.equal(pkg.type, 'module', 'Should use ESM modules');
  assert.equal(pkg.engines.node, '>=22.0.0', 'Should require Node 22+');
  
  assert.ok(pkg.scripts, 'Should have scripts');
  assert.ok(pkg.scripts.test, 'Should have test script');
  
  assert.ok(pkg.dependencies, 'Should have dependencies');
  assert.ok(pkg.dependencies.express, 'Should depend on express');
  assert.ok(pkg.dependencies.ws, 'Should depend on ws');
  
  assert.ok(pkg.repository, 'Should have repository');
  assert.equal(pkg.repository.url, 'https://github.com/PersiaF04/le-concierge-vibe.git');
  
  assert.ok(pkg.license, 'Should have license');
  assert.equal(pkg.license, 'MIT', 'License should be MIT');
});

// Test 3: README.md has required sections
test('README.md has required sections', async (t) => {
  const readmePath = resolve(rootDir, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');

  const requiredSections = [
    '# Le Concierge',
    'Smart intercom',
    'Mistral Vibe Hackathon',
    'Le Chonk',
    'Node 22',
    '## Problem',
    '## What It Does',
    '## Demo',
    '## How It Works',
    '## Track',
    '## Tech Stack',
    '## Run Locally',
    '## Privacy',
    '## Team'
  ];

  for (const section of requiredSections) {
    await t.test(`README contains: ${section}`, () => {
      assert.ok(readme.includes(section), `README should contain: ${section}`);
    });
  }
});

// Test 4: AGENTS.md has required sections
test('AGENTS.md has required sections', async (t) => {
  const agentsPath = resolve(rootDir, 'AGENTS.md');
  const agents = readFileSync(agentsPath, 'utf8');

  const requiredSections = [
    '# AGENTS.md',
    'Working Agreement',
    '## Principles',
    '## Roles',
    '## Workflow',
    '## Communication',
    '## Replay Mode',
    '## Security',
    '## GitHub'
  ];

  for (const section of requiredSections) {
    await t.test(`AGENTS.md contains: ${section}`, () => {
      assert.ok(agents.includes(section), `AGENTS.md should contain: ${section}`);
    });
  }
});

// Test 5: Architecture YAML is valid
test('architecture.yaml has required components', async (t) => {
  const archPath = resolve(rootDir, 'docs/architecture/architecture.yaml');
  const arch = readFileSync(archPath, 'utf8');

  const requiredComponents = [
    'name: Le Concierge',
    'version:',
    'system_context:',
    'components:',
    'data_flows:',
    'ai_integrations:',
    'database:',
    'deployment:',
    'testing:',
    'monitoring:'
  ];

  for (const component of requiredComponents) {
    await t.test(`architecture.yaml contains: ${component}`, () => {
      assert.ok(arch.includes(component), `architecture.yaml should contain: ${component}`);
    });
  }
});

// Test 6: Docs are complete
test('Required documentation files exist', async (t) => {
  const docsPath = resolve(rootDir, 'docs');
  const requiredDocs = [
    'architecture/architecture.yaml',
    'decisions.md',
    'demo.md'
  ];

  for (const doc of requiredDocs) {
    await t.test(`Doc exists: ${doc}`, () => {
      const fullPath = resolve(docsPath, doc);
      try {
        readFileSync(fullPath, { flag: 'r' });
        assert.ok(true, `Doc ${doc} should exist`);
      } catch (err) {
        assert.fail(`Doc ${doc} does not exist: ${err.message}`);
      }
    });
  }
});

// Test 7: .gitignore has required patterns
test('.gitignore has required patterns', async (t) => {
  const gitignorePath = resolve(rootDir, '.gitignore');
  const gitignore = readFileSync(gitignorePath, 'utf8');

  const requiredPatterns = [
    'node_modules/',
    '.env',
    '.replay/',
    '*.db',
    '*.log'
  ];

  for (const pattern of requiredPatterns) {
    await t.test(`gitignore contains: ${pattern}`, () => {
      assert.ok(gitignore.includes(pattern), `.gitignore should contain: ${pattern}`);
    });
  }
});

// Test 8: .gitattributes enforces LF
test('.gitattributes enforces LF line endings', async (t) => {
  const gitattrsPath = resolve(rootDir, '.gitattributes');
  const gitattrs = readFileSync(gitattrsPath, 'utf8');

  assert.ok(gitattrs.includes('eol=lf'), '.gitattributes should enforce LF line endings');
  assert.ok(gitattrs.includes('text=auto'), '.gitattributes should use text=auto');
});

// Test 9: API endpoints are documented
test('API endpoints are documented in README', async (t) => {
  const readmePath = resolve(rootDir, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');

  // Check for API section and some key endpoints
  const requiredContent = [
    'API Endpoints',
    '/residents',
    '/events',
    '/visits',
    '/presence',
    '/live'
  ];

  for (const content of requiredContent) {
    await t.test(`README documents: ${content}`, () => {
      assert.ok(readme.includes(content), `README should document: ${content}`);
    });
  }
});

// Test 10: Environment variables are documented
test('Environment variables are documented in README', async (t) => {
  const readmePath = resolve(rootDir, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');

  const requiredVars = [
    'MISTRAL_API_KEY',
    'PORT',
    'NODE_ENV'
  ];

  for (const varName of requiredVars) {
    await t.test(`README documents env var: ${varName}`, () => {
      assert.ok(readme.includes(varName), `README should document: ${varName}`);
    });
  }
});

// Test 11: LICENSE file exists
test('LICENSE file exists', async (t) => {
  const licensePath = resolve(rootDir, 'LICENSE');
  try {
    const license = readFileSync(licensePath, 'utf8');
    assert.ok(license.includes('MIT License'), 'Should have MIT License');
  } catch (err) {
    assert.fail(`LICENSE file does not exist: ${err.message}`);
  }
});

// Test 12: .env.example exists
test('.env.example exists', async (t) => {
  const envPath = resolve(rootDir, '.env.example');
  try {
    const env = readFileSync(envPath, 'utf8');
    assert.ok(env.includes('MISTRAL_API_KEY'), '.env.example should document MISTRAL_API_KEY');
  } catch (err) {
    assert.fail(`.env.example does not exist: ${err.message}`);
  }
});

console.log('\n✅ All smoke tests passed! Project is properly scaffolded.\n');
