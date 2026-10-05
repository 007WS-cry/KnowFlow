/**
 * Older uploads may have stored UTF-8 filename bytes after Multer decoded them as Latin-1.
 * Repair those names when returning them, while leaving already-correct Unicode untouched.
 */
export function repairFilenameEncoding(filename: string): string {
  if (!/[\u00c0-\u00ff][\u0080-\u00bf]/u.test(filename)) return filename;

  const repaired = Buffer.from(filename, 'latin1').toString('utf8');
  if (!repaired || repaired.includes('\uFFFD')) return filename;
  return repaired;
}
