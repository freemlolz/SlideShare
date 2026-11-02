import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const android = path.join(root, 'android');
const javaHome = process.env.JAVA_HOME || (process.platform === 'darwin' ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home' : '');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(homedir(), 'Library/Android/sdk');
const environment = { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}), ANDROID_HOME: sdk };
const signing = path.join(android, '.signing');
mkdirSync(signing, { recursive: true, mode: 0o700 });
const keyfile = path.join(signing, 'beta-release.jks');
const properties = path.join(signing, 'beta.properties');
if (existsSync(keyfile) !== existsSync(properties)) throw new Error('Incomplete beta signing files. Restore the original key and properties; do not replace an existing signing identity.');
if (!existsSync(keyfile)) {
  const password = randomBytes(32).toString('hex');
  const keytool = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool') : 'keytool';
  execFileSync(keytool, ['-genkeypair', '-keystore', keyfile, '-storetype', 'JKS', '-alias', 'slidesync-beta',
    '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=SlideSync Local Beta',
    '-storepass:env', 'SLIDESYNC_BETA_PASSWORD', '-keypass:env', 'SLIDESYNC_BETA_PASSWORD'],
  { env: { ...environment, SLIDESYNC_BETA_PASSWORD: password }, stdio: ['ignore', 'ignore', 'pipe'] });
  writeFileSync(properties, `storePassword=${password}\n`, { mode: 0o600 });
  chmodSync(keyfile, 0o600);
}
const gradle = path.join(android, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
execFileSync(gradle, ['--no-daemon', ':app:assembleRelease', ':app:testDebugUnitTest', ':app:lintRelease'], { cwd: android, env: environment, stdio: 'inherit' });
const output = path.join(root, 'dist/android');
mkdirSync(output, { recursive: true });
const filename = 'SlideSync-Local-Android-0.1.0-beta.1.apk';
copyFileSync(path.join(android, 'app/build/outputs/apk/release/app-release.apk'), path.join(output, filename));
const digest = createHash('sha256').update(readFileSync(path.join(output, filename))).digest('hex');
writeFileSync(path.join(output, 'SHA256SUMS'), `${digest}  ${filename}\n`);
console.log(`\nAPK: ${path.join(output, filename)}\nSigning key stays in android/.signing. Back it up privately to preserve update compatibility.`);
