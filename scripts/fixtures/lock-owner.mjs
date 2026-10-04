import { withStateLock } from '../state.mjs';
if (process.argv[2] !== 'exit') {
  await withStateLock(process.argv[2], async () => {
    const released = new Promise(resolve => process.once('message', resolve));
    process.send('locked');
    await released;
  });
  process.disconnect();
}
