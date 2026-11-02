package io.github.freemlolz.slidesync;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import java.io.File;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public final class PresentationService extends Service {
    public static final String START = "io.github.freemlolz.slidesync.START";
    public static final String STOP = "io.github.freemlolz.slidesync.STOP";
    private static final String CHANNEL = "presentation";
    private final LocalBinder binder = new LocalBinder();
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler lifecycle = new Handler(Looper.getMainLooper());
    private int latestStartId;
    private volatile PresentationServer server;
    private volatile String status = "Оберіть PDF, щоб почати.";
    private volatile boolean busy;
    private volatile boolean stopping;
    private volatile long generation;
    private Future<?> preparation;
    private PowerManager.WakeLock wakeLock;

    public final class LocalBinder extends Binder { public PresentationService getService() { return PresentationService.this; } }
    @Override public IBinder onBind(Intent intent) { return binder; }
    public PresentationServer server() { return server; }
    public String status() { return status; }
    public boolean busy() { return busy || stopping; }

    @Override public void onCreate() {
        super.onCreate();
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Показ презентації", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Залишається видимим, поки телефон передає слайди.");
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
        File root = new File(getCacheDir(), "slidesync");
        File[] abandoned = root.listFiles();
        if (abandoned != null) for (File directory : abandoned) PdfDeck.deleteDirectory(directory);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        latestStartId = startId;
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        if (STOP.equals(intent.getAction())) { stopPresentation(); return START_NOT_STICKY; }
        if (!START.equals(intent.getAction()) || intent.getData() == null || busy() || server != null) return START_NOT_STICKY;
        try {
            Notification notification = notification("Готуємо слайди…");
            if (Build.VERSION.SDK_INT >= 34) startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
            else startForeground(1, notification);
            PowerManager power = getSystemService(PowerManager.class);
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SlideSync:Presentation");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(4 * 60 * 60 * 1000L);
        } catch (RuntimeException error) {
            status = "Немає дозволу для запуску. Дозвольте локальну мережу й повторіть.";
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        busy = true;
        status = "Готуємо PDF…";
        Uri source = intent.getData();
        long expected = ++generation;
        preparation = worker.submit(() -> {
            PdfDeck prepared = null;
            PresentationServer starting = null;
            try {
                File directory = new File(new File(getCacheDir(), "slidesync"), "session-" + UUID.randomUUID());
                prepared = PdfDeck.render(this, source, directory, (done, total) -> {
                    if (generation != expected || Thread.currentThread().isInterrupted()) return;
                    status = "Готуємо слайди: " + done + " / " + total;
                    getSystemService(NotificationManager.class).notify(1, notification(status));
                });
                if (generation != expected || Thread.currentThread().isInterrupted()) return;
                starting = new PresentationServer(getAssets(), prepared);
                starting.start();
                synchronized (this) {
                    if (generation != expected) return;
                    server = starting;
                    prepared = null;
                    starting = null;
                    status = "Показ працює. Учасники можуть сканувати QR.";
                }
                getSystemService(NotificationManager.class).notify(1, notification("Показ працює · телефони приєднуються через QR"));
            } catch (Exception error) {
                if (generation == expected) {
                    String message = error.getMessage() == null ? "Не вдалося підготувати PDF." : error.getMessage();
                    lifecycle.post(() -> {
                        if (generation != expected) return;
                        status = message;
                        releasePower();
                        stopForeground(STOP_FOREGROUND_REMOVE);
                        busy = false;
                        stopSelf(latestStartId);
                    });
                }
            } finally {
                if (starting != null) starting.close();
                if (prepared != null) prepared.close();
                lifecycle.post(() -> { if (generation == expected && server != null) busy = false; });
            }
        });
        return START_NOT_STICKY;
    }

    public synchronized void stopPresentation() {
        if (stopping) return;
        stopping = true;
        long expected = ++generation;
        if (preparation != null) preparation.cancel(true);
        PresentationServer previous = server;
        server = null;
        status = "Завершуємо показ…";
        worker.execute(() -> {
            if (previous != null) { previous.close(); previous.deck().close(); }
            lifecycle.post(() -> {
                if (generation != expected) return;
                releasePower();
                stopForeground(STOP_FOREGROUND_REMOVE);
                busy = false;
                stopping = false;
                status = "Показ завершено. PDF видалено з кешу.";
                stopSelf(latestStartId);
            });
        });
    }

    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, PresentationService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_slidesync).setContentTitle("SlideSync Local")
                .setContentText(text).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
                .addAction(new Notification.Action.Builder(null, "Завершити", stop).build()).build();
    }
    private synchronized void releasePower() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }
    @Override public void onTaskRemoved(Intent intent) { stopPresentation(); }
    @Override public void onDestroy() {
        generation++;
        if (preparation != null) preparation.cancel(true);
        PresentationServer previous = server;
        server = null;
        worker.execute(() -> { if (previous != null) { previous.close(); previous.deck().close(); } });
        worker.shutdown();
        releasePower();
        super.onDestroy();
    }
}
