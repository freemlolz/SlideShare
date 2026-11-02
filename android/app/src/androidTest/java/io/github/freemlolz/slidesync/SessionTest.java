package io.github.freemlolz.slidesync;

import android.content.Context;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;
import android.app.Activity;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.os.IBinder;
import android.os.StrictMode;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.java_websocket.client.WebSocketClient;
import org.java_websocket.handshake.ServerHandshake;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class SessionTest {
    private File demo(Context context) throws Exception {
        File file = new File(context.getCacheDir(), "android-test.pdf");
        PdfDocument document = new PdfDocument();
        try {
            Paint paint = new Paint(); paint.setTextSize(40);
            for (int number = 1; number <= 3; number++) {
                PdfDocument.Page page = document.startPage(new PdfDocument.PageInfo.Builder(960, 540, number).create());
                Canvas canvas = page.getCanvas(); canvas.drawColor(Color.WHITE); canvas.drawText("Android slide " + number, 60, 180, paint); document.finishPage(page);
            }
            try (FileOutputStream output = new FileOutputStream(file)) { document.writeTo(output); }
        } finally { document.close(); }
        return file;
    }
    private HttpURLConnection request(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(5000); connection.setReadTimeout(5000); return connection;
    }
    private String read(HttpURLConnection connection) throws Exception {
        try (InputStream input = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192]; int count; while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
            return bytes.toString("UTF-8");
        } finally { connection.disconnect(); }
    }

    @Test public void renderServeAuthenticateSyncAndCleanup() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        if (android.os.Build.VERSION.SDK_INT >= 37) InstrumentationRegistry.getInstrumentation().getUiAutomation()
                .grantRuntimePermission(context.getPackageName(), "android.permission.ACCESS_LOCAL_NETWORK");
        File input = demo(context);
        File directory = new File(context.getCacheDir(), "session-test-" + System.nanoTime());
        PdfDeck deck = PdfDeck.render(context, Uri.fromFile(input), directory, (done, total) -> {});
        PresentationServer server = new PresentationServer(context.getAssets(), deck);
        WebSocketClient viewer = null;
        try {
            assertEquals(3, deck.pages.size());
            assertFalse(new File(directory, "source.pdf").exists());
            server.start();
            String base = "http://127.0.0.1:" + server.port();
            String token = Uri.parse(server.joinUrl("127.0.0.1")).getFragment().substring("token=".length());
            assertEquals(401, request(base + "/api/state").getResponseCode());
            assertEquals(403, request(base + "/api/host/slide?token=" + token).getResponseCode());
            HttpURLConnection foreign = request(base + "/api/state?token=" + token); foreign.setRequestProperty("Origin", "https://example.com");
            assertEquals(403, foreign.getResponseCode()); foreign.disconnect();
            JSONObject state = new JSONObject(read(request(base + "/api/state?token=" + token)));
            assertEquals(0, state.getInt("slide")); assertEquals(3, state.getJSONObject("deck").getJSONArray("pages").length());
            assertFalse(state.has("presence")); assertFalse(state.has("hostToken"));
            assertTrue(read(request(base + "/join")).contains("viewer.js"));
            assertEquals(200, request(base + "/slides/" + deck.id + "/1.jpg?token=" + token).getResponseCode());
            assertEquals(401, request(base + "/slides/" + deck.id + "/1.jpg").getResponseCode());
            CountDownLatch changed = new CountDownLatch(1);
            AtomicReference<Exception> failure = new AtomicReference<>();
            AtomicReference<String> closeReason = new AtomicReference<>();
            viewer = new WebSocketClient(new URI("ws://127.0.0.1:" + server.websocketPort() + "/ws?role=viewer&token=" + token), java.util.Collections.singletonMap("Origin", base)) {
                @Override public void onOpen(ServerHandshake handshake) {}
                @Override public void onMessage(String message) { try { if (new JSONObject(message).getInt("slide") == 1) changed.countDown(); } catch (Exception error) { failure.set(error); } }
                @Override public void onClose(int code, String reason, boolean remote) { closeReason.set(code + ": " + reason); }
                @Override public void onError(Exception error) { failure.set(error); }
            };
            boolean connected = viewer.connectBlocking(5, TimeUnit.SECONDS);
            assertTrue("WebSocket failed: " + failure.get() + " / " + closeReason.get(), connected);
            server.setSlide(1);
            assertTrue(changed.await(5, TimeUnit.SECONDS));
            assertNull(failure.get());
            assertEquals(1, new JSONObject(read(request(base + "/api/state?token=" + token))).getInt("slide"));
            assertEquals(1, server.participants());
        } finally {
            if (viewer != null) viewer.closeBlocking();
            server.close(); deck.close(); input.delete();
        }
        assertFalse(directory.exists());
    }

    @Test public void invalidPdfAndCancellationLeaveNoCopies() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File input = new File(context.getCacheDir(), "invalid-test.pdf");
        try (FileOutputStream output = new FileOutputStream(input)) { output.write("not a pdf".getBytes()); }
        File directory = new File(context.getCacheDir(), "invalid-render-test");
        try { PdfDeck.render(context, Uri.fromFile(input), directory, null); fail("Invalid PDF accepted"); }
        catch (java.io.IOException expected) { assertFalse(directory.exists()); }
        finally { input.delete(); }
        Thread.currentThread().interrupt();
        try { PdfDeck.render(context, Uri.EMPTY, directory, null); fail("Cancellation ignored"); }
        catch (java.io.InterruptedIOException expected) { assertFalse(directory.exists()); }
        finally { Thread.interrupted(); }
    }

    @Test public void foregroundLifecycleAndOptionalBrowserHarness() throws Exception {
        android.app.Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Context context = instrumentation.getTargetContext();
        if (android.os.Build.VERSION.SDK_INT >= 37) instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), "android.permission.ACCESS_LOCAL_NETWORK");
        if (android.os.Build.VERSION.SDK_INT >= 33) instrumentation.getUiAutomation().grantRuntimePermission(context.getPackageName(), "android.permission.POST_NOTIFICATIONS");
        File input = demo(context);
        AtomicReference<PresentationService> reference = new AtomicReference<>();
        CountDownLatch bound = new CountDownLatch(1);
        ServiceConnection binding = new ServiceConnection() {
            @Override public void onServiceConnected(ComponentName name, IBinder binder) { reference.set(((PresentationService.LocalBinder) binder).getService()); bound.countDown(); }
            @Override public void onServiceDisconnected(ComponentName name) {}
        };
        Activity activity = instrumentation.startActivitySync(new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        assertTrue(context.bindService(new Intent(context, PresentationService.class), binding, Context.BIND_AUTO_CREATE));
        assertTrue(bound.await(15, TimeUnit.SECONDS));
        PresentationService service = reference.get();
        try {
            instrumentation.runOnMainSync(() -> {
                StrictMode.VmPolicy previous = StrictMode.getVmPolicy();
                try {
                    StrictMode.setVmPolicy(new StrictMode.VmPolicy.Builder().build());
                    context.startForegroundService(new Intent(context, PresentationService.class).setAction(PresentationService.START).setData(Uri.fromFile(input)));
                } finally { StrictMode.setVmPolicy(previous); }
            });
            long deadline = System.currentTimeMillis() + 45_000;
            while (service.server() == null && System.currentTimeMillis() < deadline) Thread.sleep(100);
            assertNotNull(service.status(), service.server());
            File directory = service.server().deck().directory;
            boolean harness = "true".equals(InstrumentationRegistry.getArguments().getString("browserHarness"));
            if (harness) {
                JSONObject connection = new JSONObject().put("url", service.server().joinUrl("127.0.0.1"))
                        .put("port", service.server().port()).put("websocketPort", service.server().websocketPort());
                Files.write(new File(context.getCacheDir(), "browser-harness.json").toPath(), connection.toString().getBytes(StandardCharsets.UTF_8));
                File commands = new File(context.getCacheDir(), "browser-harness-command");
                deadline = System.currentTimeMillis() + 180_000;
                boolean finished = false;
                while (System.currentTimeMillis() < deadline) {
                    if (commands.exists()) {
                        String command = new String(Files.readAllBytes(commands.toPath()), StandardCharsets.UTF_8).trim();
                        commands.delete();
                        if ("stop".equals(command)) { finished = true; break; }
                        if (command.startsWith("slide:")) service.server().setSlide(Integer.parseInt(command.substring(6)));
                    }
                    Thread.sleep(100);
                }
                assertTrue("Browser harness did not finish", finished);
            } else {
                java.util.concurrent.atomic.AtomicBoolean clicked = new java.util.concurrent.atomic.AtomicBoolean();
                deadline = System.currentTimeMillis() + 10_000;
                while (!clicked.get() && System.currentTimeMillis() < deadline) {
                    instrumentation.runOnMainSync(() -> {
                        java.util.ArrayList<android.view.View> matches = new java.util.ArrayList<>();
                        activity.getWindow().getDecorView().findViewsWithText(matches, "Далі →", android.view.View.FIND_VIEWS_WITH_TEXT);
                        if (!matches.isEmpty() && matches.get(0).isShown() && matches.get(0).isEnabled()) {
                            matches.get(0).performClick(); clicked.set(true);
                        }
                    });
                    if (!clicked.get()) Thread.sleep(100);
                }
                assertTrue("Presenter controls did not become ready", clicked.get());
                assertEquals(1, service.server().currentSlide());
                instrumentation.runOnMainSync(activity::recreate);
                instrumentation.waitForIdleSync();
                assertEquals(1, service.server().currentSlide());
            }
            instrumentation.runOnMainSync(service::stopPresentation);
            deadline = System.currentTimeMillis() + 15_000;
            while (service.busy() && System.currentTimeMillis() < deadline) Thread.sleep(100);
            assertNull(service.server());
            assertFalse(directory.exists());
        } finally {
            instrumentation.runOnMainSync(service::stopPresentation);
            context.unbindService(binding);
            input.delete();
            new File(context.getCacheDir(), "browser-harness.json").delete();
            new File(context.getCacheDir(), "browser-harness-command").delete();
            instrumentation.runOnMainSync(activity::finish);
        }
    }
}
