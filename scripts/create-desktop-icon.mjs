import { mkdir, writeFile } from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const root = new URL('../desktop/', import.meta.url);
const image = await loadImage(new URL('icon.svg', root));
const canvas = createCanvas(1024, 1024);
canvas.getContext('2d').drawImage(image, 0, 0);
await mkdir(new URL('generated/', root), { recursive: true });
await writeFile(new URL('generated/icon.png', root), await canvas.encode('png'));
