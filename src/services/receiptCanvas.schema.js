// Declarative layout only: stored templates never contain executable HTML/CSS.
const number = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
const string = (value, fallback = '', max = 4000) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : fallback;
const color = (value, fallback) => /^#[a-f0-9]{6}$/i.test(value) || value === 'transparent' ? value : fallback;
export function normalizeCanvasElements(value, pageSize) {
  const width = pageSize === 'A5' ? 148 : 210;
  const height = pageSize === 'A5' ? 210 : 297;
  return (Array.isArray(value) ? value : []).slice(0, 150).filter(item => item && ['text', 'field', 'details', 'line', 'box', 'image', 'qr', 'customer_signature', 'authority_signature', 'copy_label'].includes(item.type)).map((item, index) => ({
    id: /^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ? item.id : `element_${index}`,
    type: item.type, text: string(item.text), field: string(item.field, '', 80),
    x: number(item.x, 12, 0, width - 1), y: number(item.y, 12, 0, height - 1),
    width: number(item.width, 80, 1, width), height: number(item.height, 10, 0.2, height),
    font_size: number(item.font_size, 12, 6, 96), bold: item.bold === true, italic: item.italic === true,
    align: ['left', 'center', 'right'].includes(item.align) ? item.align : 'left',
    color: color(item.color, '#222222'), background: color(item.background, 'transparent'),
    border_color: color(item.border_color, '#222222'), border_width: number(item.border_width, 0, 0, 5),
    prefix: string(item.prefix), suffix: string(item.suffix),
    hidden: item.hidden === true, hide_empty: item.hide_empty !== false,
    src: /^(https?:\/\/|\/|data:image\/(png|jpeg|webp|gif);base64,)/i.test(item.src || '') ? string(item.src, '', 2000000) : '',
  }));
}
