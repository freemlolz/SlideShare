package io.github.freemlolz.slidesync;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.provider.OpenableColumns;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.MultiFormatWriter;
import com.google.zxing.common.BitMatrix;
import java.util.ArrayList;
import java.util.List;

public final class MainActivity extends Activity {
    private static final int PICK_PDF = 10;
    private static final int PERMISSIONS = 11;
    private PresentationService service;
    private boolean bound;
    private Uri selected;
    private final Handler updates = new Handler(android.os.Looper.getMainLooper());
    private TextView fileLabel, status, pageLabel, metrics, joinLink;
    private Button choose, start, cancel, previous, next, stop, share;
    private ImageView preview, qr;
    private ProgressBar progress;
    private LinearLayout live;
    private Spinner networks;
    private List<String> addresses = new ArrayList<>();
    private String previewKey = "";
    private String qrUrl = "";
    private Bitmap previewBitmap;
    private Bitmap qrBitmap;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) { service = ((PresentationService.LocalBinder) binder).getService(); render(); }
        @Override public void onServiceDisconnected(ComponentName name) { service = null; render(); }
    };
    private final Runnable tick = new Runnable() {
        @Override public void run() { render(); updates.postDelayed(this, 1000); }
    };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (saved != null && saved.getString("pdf") != null) selected = Uri.parse(saved.getString("pdf"));
        buildUi();
        if (selected != null) fileLabel.setText(displayName(selected));
    }

    private void buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(20), dp(20), dp(24));
        root.setBackgroundColor(Color.rgb(243, 245, 250));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                root.setPadding(dp(20) + bars.left, dp(12) + bars.top, dp(20) + bars.right, dp(24) + bars.bottom);
            } else root.setPadding(dp(20), dp(20) + insets.getSystemWindowInsetTop(), dp(20), dp(24) + insets.getSystemWindowInsetBottom());
            return insets;
        });
        scroll.addView(root);
        root.addView(text("SLIDESYNC LOCAL", 14, Color.rgb(79, 70, 229), true));
        TextView title = text("Ваш телефон.\nУсі екрани.", 32, Color.rgb(25, 31, 49), true);
        root.addView(title, margins());
        root.addView(text("Android Beta · Без ноутбука та хмари", 15, Color.DKGRAY, false), margins());
        LinearLayout upload = card();
        upload.addView(text("1. Оберіть презентацію", 21, Color.BLACK, true));
        upload.addView(text("PDF до 40 МіБ · 100 сторінок · без пароля", 13, Color.DKGRAY, false), margins());
        fileLabel = text("Файл ще не обрано", 15, Color.DKGRAY, false);
        upload.addView(fileLabel, margins());
        choose = button("Вибрати PDF", false);
        choose.setOnClickListener(view -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("application/pdf").addCategory(Intent.CATEGORY_OPENABLE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), PICK_PDF));
        upload.addView(choose, margins());
        start = button("Почати показ", true);
        start.setOnClickListener(view -> requestStart());
        upload.addView(start, margins());
        status = text("Оберіть PDF, щоб почати.", 15, Color.DKGRAY, false);
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        upload.addView(status, margins());
        progress = new ProgressBar(this);
        upload.addView(progress);
        cancel = button("Скасувати підготовку", false);
        cancel.setOnClickListener(view -> { if (service != null) service.stopPresentation(); render(); });
        upload.addView(cancel, margins());
        root.addView(upload, margins());
        live = card();
        live.addView(text("2. Запросіть учасників", 21, Color.BLACK, true));
        live.addView(text("Той самий Wi-Fi. Учасники відкривають QR у Safari або Chrome — без встановлення.", 14, Color.DKGRAY, false), margins());
        networks = new Spinner(this);
        networks.setContentDescription("Адреса Wi-Fi");
        networks.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(AdapterView<?> parent, View view, int position, long id) { updateQr(); }
            @Override public void onNothingSelected(AdapterView<?> parent) {}
        });
        live.addView(networks, margins());
        qr = new ImageView(this);
        qr.setContentDescription("QR для приєднання");
        LinearLayout.LayoutParams qrSize = new LinearLayout.LayoutParams(dp(240), dp(240));
        qrSize.gravity = Gravity.CENTER_HORIZONTAL;
        live.addView(qr, qrSize);
        joinLink = text("", 14, Color.rgb(79, 70, 229), false);
        joinLink.setTextIsSelectable(true);
        live.addView(joinLink, margins());
        share = button("Поділитися посиланням", false);
        share.setOnClickListener(view -> { if (!qrUrl.isEmpty()) startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, qrUrl), "Посилання для учасників")); });
        live.addView(share, margins());
        preview = new ImageView(this);
        preview.setAdjustViewBounds(true);
        preview.setContentDescription("Поточний слайд");
        preview.setBackgroundColor(Color.rgb(24, 31, 48));
        live.addView(preview, new LinearLayout.LayoutParams(-1, dp(220)));
        pageLabel = text("", 18, Color.BLACK, true);
        pageLabel.setGravity(Gravity.CENTER);
        live.addView(pageLabel, margins());
        LinearLayout controls = new LinearLayout(this);
        previous = button("← Назад", false);
        next = button("Далі →", true);
        previous.setOnClickListener(view -> { if (service != null && service.server() != null) { service.server().setSlide(service.server().currentSlide() - 1); render(); } });
        next.setOnClickListener(view -> { if (service != null && service.server() != null) { service.server().setSlide(service.server().currentSlide() + 1); render(); } });
        controls.addView(previous, new LinearLayout.LayoutParams(0, dp(52), 1));
        controls.addView(next, new LinearLayout.LayoutParams(0, dp(52), 1));
        live.addView(controls, margins());
        metrics = text("", 14, Color.DKGRAY, false);
        live.addView(metrics, margins());
        stop = button("Завершити показ", false);
        stop.setOnClickListener(view -> new AlertDialog.Builder(this).setTitle("Завершити показ?").setMessage("Телефони від’єднаються. Тимчасову копію PDF буде видалено.")
                .setPositiveButton("Завершити", (dialog, which) -> { if (service != null) service.stopPresentation(); render(); }).setNegativeButton("Продовжити", null).show());
        live.addView(stop, margins());
        root.addView(live, margins());
        root.addView(text("Показ працює, поки є повідомлення SlideSync. Економія батареї може перервати зв’язок. Публічний Wi-Fi може блокувати пристрої. HTTP/WS не шифруються — тільки довірена локальна мережа.", 13, Color.DKGRAY, false), margins());
        root.addView(text("У цій бета-версії: PDF, синхронізація та історія. Малювання й опитування ще не підтримуються.", 13, Color.DKGRAY, false), margins());
        Button about = button("Про застосунок і ліцензії", false);
        about.setOnClickListener(view -> showLicenses());
        root.addView(about, margins());
        setContentView(scroll);
        render();
    }

    private void requestStart() {
        if (selected == null) return;
        List<String> missing = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED) missing.add("android.permission.ACCESS_LOCAL_NETWORK");
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) missing.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!missing.isEmpty()) { requestPermissions(missing.toArray(new String[0]), PERMISSIONS); return; }
        begin();
    }
    @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grants) {
        super.onRequestPermissionsResult(requestCode, permissions, grants);
        if (requestCode != PERMISSIONS) return;
        if (Build.VERSION.SDK_INT >= 37 && checkSelfPermission("android.permission.ACCESS_LOCAL_NETWORK") != PackageManager.PERMISSION_GRANTED) {
            new AlertDialog.Builder(this).setTitle("Потрібен доступ до локальної мережі").setMessage("Інакше телефони не зможуть приєднатися. Дозвольте локальну мережу в налаштуваннях застосунку.").setPositiveButton("Зрозуміло", null).show();
            return;
        }
        begin();
    }
    private void begin() {
        if (service == null || service.busy() || service.server() != null || selected == null) return;
        try {
            startForegroundService(new Intent(this, PresentationService.class).setAction(PresentationService.START).setData(selected).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
            start.setEnabled(false);
        } catch (RuntimeException error) { status.setText("Не вдалося почати показ. Перевірте дозволи та повторіть."); }
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == PICK_PDF && resultCode == RESULT_OK && data != null) { selected = data.getData(); fileLabel.setText(displayName(selected)); render(); }
    }
    private String displayName(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {}
        return "Презентація.pdf";
    }

    private void render() {
        if (start == null) return;
        PresentationServer running = service == null ? null : service.server();
        boolean preparing = service != null && service.busy();
        status.setText(service == null ? "Підключаємо застосунок…" : service.status());
        choose.setEnabled(!preparing && running == null);
        start.setEnabled(service != null && selected != null && !preparing && running == null);
        progress.setVisibility(preparing ? View.VISIBLE : View.GONE);
        cancel.setVisibility(preparing ? View.VISIBLE : View.GONE);
        live.setVisibility(running == null ? View.GONE : View.VISIBLE);
        if (running == null) {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            if (previewBitmap != null) { preview.setImageDrawable(null); previewBitmap.recycle(); previewBitmap = null; }
            if (qrBitmap != null) { qr.setImageDrawable(null); qrBitmap.recycle(); qrBitmap = null; }
            previewKey = ""; qrUrl = "";
            return;
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        PdfDeck deck = running.deck();
        int index = running.currentSlide();
        pageLabel.setText("Слайд " + (index + 1) + " / " + deck.pages.size());
        previous.setEnabled(index > 0);
        next.setEnabled(index + 1 < deck.pages.size());
        metrics.setText("WS-вкладок: " + running.participants() + " · усі слайди готові: " + running.readyCount() + "\nHTTP-резерв працює, але не врахований у цьому лічильнику.");
        String key = deck.id + ":" + index;
        if (!key.equals(previewKey)) {
            Bitmap bitmap = BitmapFactory.decodeFile(deck.slide(index).getAbsolutePath());
            preview.setImageBitmap(bitmap);
            if (previewBitmap != null) previewBitmap.recycle();
            previewBitmap = bitmap;
            previewKey = key;
        }
        List<String> available = NetworkAddresses.list();
        if (!available.equals(addresses)) {
            addresses = available;
            networks.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, addresses));
        }
        updateQr();
    }
    private void updateQr() {
        if (service == null || service.server() == null) return;
        if (addresses.isEmpty()) {
            qrUrl = "";
            joinLink.setText("Підключіть телефон до Wi-Fi. Потім тут з’явиться QR.");
            qr.setVisibility(View.GONE); share.setEnabled(false); return;
        }
        String address = String.valueOf(networks.getSelectedItem());
        if (!addresses.contains(address)) address = addresses.get(0);
        String url = service.server().joinUrl(address);
        if (url.equals(qrUrl)) return;
        try {
            BitMatrix matrix = new MultiFormatWriter().encode(url, BarcodeFormat.QR_CODE, 640, 640);
            Bitmap bitmap = Bitmap.createBitmap(640, 640, Bitmap.Config.ARGB_8888);
            int[] pixels = new int[640 * 640];
            for (int row = 0; row < 640; row++) for (int column = 0; column < 640; column++) pixels[row * 640 + column] = matrix.get(column, row) ? Color.BLACK : Color.WHITE;
            bitmap.setPixels(pixels, 0, 640, 0, 0, 640, 640);
            qr.setImageBitmap(bitmap);
            if (qrBitmap != null) qrBitmap.recycle();
            qrBitmap = bitmap;
            qrUrl = url;
            joinLink.setText(url);
            qr.setVisibility(View.VISIBLE);
            share.setEnabled(true);
        } catch (Exception error) { joinLink.setText(url); }
    }

    private TextView text(String content, int size, int color, boolean bold) {
        TextView view = new TextView(this); view.setText(content); view.setTextSize(size); view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }
    private void showLicenses() {
        StringBuilder content = new StringBuilder("SlideSync Local Android 0.1.0-beta.1\nЛокальний показ PDF без хмари.\n\n");
        for (String asset : new String[]{"THIRD_PARTY_NOTICES.txt", "LICENSE-APACHE-2.0.txt"}) {
            try (java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(getAssets().open(asset), java.nio.charset.StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) content.append(line).append('\n');
            } catch (java.io.IOException error) { content.append(asset).append(": недоступно\n"); }
        }
        ScrollView scroll = new ScrollView(this);
        TextView notice = text(content.toString(), 13, Color.DKGRAY, false);
        notice.setPadding(dp(20), dp(10), dp(20), dp(10));
        scroll.addView(notice);
        new AlertDialog.Builder(this).setTitle("Про SlideSync Local").setView(scroll).setPositiveButton("Закрити", null).show();
    }
    private Button button(String label, boolean primary) {
        Button view = new Button(this); view.setText(label); view.setAllCaps(false); view.setTextSize(16);
        view.setTextColor(primary ? Color.WHITE : Color.rgb(55, 65, 81));
        GradientDrawable background = new GradientDrawable(); background.setColor(primary ? Color.rgb(79, 70, 229) : Color.rgb(235, 238, 246)); background.setCornerRadius(dp(12));
        view.setBackground(background); view.setMinimumHeight(dp(52));
        return view;
    }
    private LinearLayout card() {
        LinearLayout view = new LinearLayout(this); view.setOrientation(LinearLayout.VERTICAL); view.setPadding(dp(18), dp(18), dp(18), dp(18));
        GradientDrawable background = new GradientDrawable(); background.setColor(Color.WHITE); background.setCornerRadius(dp(20)); view.setBackground(background); return view;
    }
    private LinearLayout.LayoutParams margins() { LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2); params.topMargin = dp(14); return params; }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    @Override protected void onStart() { super.onStart(); bound = bindService(new Intent(this, PresentationService.class), connection, Context.BIND_AUTO_CREATE); updates.post(tick); }
    @Override protected void onStop() { updates.removeCallbacks(tick); if (bound) { unbindService(connection); bound = false; } service = null; super.onStop(); }
    @Override protected void onSaveInstanceState(Bundle state) { if (selected != null) state.putString("pdf", selected.toString()); super.onSaveInstanceState(state); }
    @Override protected void onDestroy() { if (previewBitmap != null) previewBitmap.recycle(); if (qrBitmap != null) qrBitmap.recycle(); super.onDestroy(); }
}
