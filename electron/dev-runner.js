import { spawn } from 'child_process';
import path from 'path';

delete process.env.ELECTRON_RUN_AS_NODE;

const vite = spawn('npx', ['vite'], { stdio: 'inherit', shell: true });

const waitAndElectron = spawn('npx', ['wait-on', 'http://localhost:5174'], {
    stdio: 'inherit',
    shell: true
});

waitAndElectron.on('close', (code) => {
    if (code === 0) {
        console.log('Vite is ready. Launching Electron...');
        const electronProg = process.platform === 'win32' ? 'electron.cmd' : 'electron';
        const electronPath = path.resolve('node_modules', '.bin', electronProg);
        const electronApp = spawn(electronPath, ['.'], { stdio: 'inherit', shell: true });
        electronApp.on('close', () => { vite.kill(); process.exit(); });
    } else {
        vite.kill();
        process.exit(code);
    }
});
