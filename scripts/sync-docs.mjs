// Copies the game's scene modules into docs/ so the project site's 3D hero
// uses the exact same table and tile code as the game.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['textures.js', 'tween.js', 'table.js', 'tiles3d.js', 'tileFaces.js'];
const dest = path.join(root, 'docs/js/scene');
mkdirSync(dest, { recursive: true });
for (const f of files) copyFileSync(path.join(root, 'public/js/scene', f), path.join(dest, f));
mkdirSync(path.join(root, 'docs/fonts'), { recursive: true });
for (const f of ['tiles-cjk.woff2', 'LICENSE.txt']) copyFileSync(path.join(root, 'public/fonts', f), path.join(root, 'docs/fonts', f));
console.log(`Synced ${files.length} scene modules into docs/js/scene`);
