import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function makePdf(pageCount = 5, { rotation = 0 } = {}) {
  const themes = [
    { color: '0.09 0.14 0.24', title: 'Every screen. One story.', subtitle: 'SlideSync Local / An offline presentation', accent: '0.36 0.65 1' },
    { color: '0.12 0.28 0.25', title: 'Connect to the same Wi-Fi.', subtitle: 'Scan the QR. Open your browser. You are in.', accent: '0.45 0.88 0.68' },
    { color: '0.24 0.18 0.37', title: 'Stay in sync.', subtitle: 'One presenter. All phones. No apps to install.', accent: '0.75 0.61 1' },
    { color: '0.3 0.19 0.12', title: 'Ready before the next slide.', subtitle: 'Images preload while you focus on the story.', accent: '1 0.71 0.4' },
    { color: '0.09 0.14 0.24', title: 'Local. Simple. Yours.', subtitle: 'No accounts. No cloud. No paid APIs.', accent: '0.36 0.65 1' },
  ];
  const objects = [];
  const add = (content) => { objects.push(content); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (let index = 0; index < pageCount; index += 1) {
    const theme = themes[index % themes.length];
    const content = `${theme.color} rg 0 0 960 540 re f\n${theme.accent} rg 64 414 48 6 re f\n1 1 1 rg BT /F1 42 Tf 64 300 Td (${theme.title}) Tj ET\n0.78 0.83 0.9 rg BT /F1 20 Tf 64 246 Td (${theme.subtitle}) Tj ET\n${theme.accent} rg BT /F1 13 Tf 64 64 Td (SLIDESYNC LOCAL) Tj ET\n0.65 0.73 0.84 rg BT /F1 13 Tf 852 64 Td (${index + 1} / ${pageCount}) Tj ET\n`;
    const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Rotate ${rotation} /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = path.resolve('demo.pdf');
  await writeFile(output, makePdf());
  console.log(`Демонстраційний PDF: ${output}`);
}
