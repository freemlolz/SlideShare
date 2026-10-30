export async function readApiResponse(response) {
  const restart = 'Перезапустіть SlideSync Local та відкрийте нове посилання ведучого з термінала.';
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error(response.status === 404
      ? `Запущений сервер не підтримує цю функцію. ${restart}`
      : `Сервер повернув неочікувану відповідь (${response.status}). ${restart}`);
  }
  let body;
  try { body = await response.json(); }
  catch { throw new Error(`Не вдалося прочитати відповідь сервера. ${restart}`); }
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `Запит не виконано (${response.status}).`);
  return body;
}
