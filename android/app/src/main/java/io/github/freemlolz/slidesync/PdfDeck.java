package io.github.freemlolz.slidesync;

import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

public final class PdfDeck implements AutoCloseable {
    public static final int MAX_PDF_BYTES = 40 * 1024 * 1024;
    public static final int MAX_PAGES = 100;
    public static final int MAX_IMAGE_BYTES = 32 * 1024 * 1024;

    public final String id;
    public final String name;
    public final File directory;
    public final List<PageInfo> pages;
    public final long totalBytes;

    public static final class PageInfo {
        public final int width;
        public final int height;
        public final long bytes;

        private PageInfo(int width, int height, long bytes) {
            this.width = width;
            this.height = height;
            this.bytes = bytes;
        }
    }

    public interface Progress {
        void update(int done, int total);
    }

    private PdfDeck(String name, File directory, List<PageInfo> pages, long totalBytes) {
        this.id = UUID.randomUUID().toString();
        this.name = name;
        this.directory = directory;
        this.pages = Collections.unmodifiableList(new ArrayList<>(pages));
        this.totalBytes = totalBytes;
    }

    public static PdfDeck render(Context context, Uri source, File sessionDirectory,
                                 Progress progress) throws IOException {
        checkInterrupted();
        if (context == null || source == null || sessionDirectory == null) {
            throw new IOException("Не вказано PDF або каталог сеансу.");
        }
        if (Files.isSymbolicLink(sessionDirectory.toPath())) {
            throw new IOException("Каталог сеансу не може бути символічним посиланням.");
        }
        File directory = sessionDirectory.getCanonicalFile();
        if (directory.getParentFile() == null) {
            throw new IOException("Некоректний каталог сеансу.");
        }
        if (directory.exists()) {
            String[] entries = directory.list();
            if (entries == null || entries.length != 0) {
                throw new IOException("Потрібен окремий порожній каталог сеансу.");
            }
        } else if (!directory.mkdirs()) {
            throw new IOException("Не вдалося створити каталог сеансу.");
        }

        boolean complete = false;
        try {
            String name = displayName(context, source);
            File input = new File(directory, "source.pdf");
            copySource(context, source, input);
            verifyHeader(input);
            List<PageInfo> pages = new ArrayList<>();
            long totalBytes = 0;
            try (ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(
                    input, ParcelFileDescriptor.MODE_READ_ONLY);
                 PdfRenderer renderer = openRenderer(descriptor)) {
                int pageCount = renderer.getPageCount();
                if (pageCount < 1) {
                    throw new IOException("PDF не містить сторінок.");
                }
                if (pageCount > MAX_PAGES) {
                    throw new IOException("PDF містить забагато сторінок. Дозволено до 100.");
                }
                if (progress != null) {
                    progress.update(0, pageCount);
                }
                for (int pageIndex = 0; pageIndex < pageCount; pageIndex++) {
                    checkInterrupted();
                    try (PdfRenderer.Page page = renderer.openPage(pageIndex)) {
                        if (page.getWidth() <= 0 || page.getHeight() <= 0) {
                            throw new IOException("PDF містить сторінку з некоректним розміром.");
                        }
                        double scale = Math.min(1.0,
                                1280.0 / Math.max(page.getWidth(), page.getHeight()));
                        int width = Math.max(1, (int) Math.round(page.getWidth() * scale));
                        int height = Math.max(1, (int) Math.round(page.getHeight() * scale));
                        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                        try {
                            bitmap.eraseColor(Color.WHITE);
                            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                            checkInterrupted();
                            try (ByteArrayOutputStream jpeg = new ByteArrayOutputStream()) {
                                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 82, jpeg)) {
                                    throw new IOException("Не вдалося зберегти сторінку PDF як JPEG.");
                                }
                                checkInterrupted();
                                if (jpeg.size() > MAX_IMAGE_BYTES - totalBytes) {
                                    throw new IOException("Зображення сторінок перевищують ліміт 32 МіБ.");
                                }
                                try (FileOutputStream output = new FileOutputStream(
                                        slideFile(directory, pageIndex))) {
                                    jpeg.writeTo(output);
                                }
                                pages.add(new PageInfo(width, height, jpeg.size()));
                                totalBytes += jpeg.size();
                            }
                        } finally {
                            bitmap.recycle();
                        }
                    }
                    checkInterrupted();
                    if (progress != null) {
                        progress.update(pageIndex + 1, pageCount);
                    }
                }
            }
            checkInterrupted();
            if (!input.delete()) {
                throw new IOException("Не вдалося видалити тимчасову копію PDF.");
            }
            PdfDeck deck = new PdfDeck(name, directory, pages, totalBytes);
            complete = true;
            return deck;
        } catch (InterruptedIOException exception) {
            throw exception;
        } catch (IOException exception) {
            throw new IOException("Не вдалося підготувати PDF: " + exception.getMessage(), exception);
        } catch (SecurityException exception) {
            throw new IOException("Немає доступу до PDF або каталогу сеансу. Виберіть файл повторно.",
                    exception);
        } catch (RuntimeException exception) {
            throw new IOException("Не вдалося прочитати PDF. Файл пошкоджений або має непідтримуваний формат.",
                    exception);
        } catch (OutOfMemoryError error) {
            throw new IOException("Недостатньо пам’яті для обробки PDF. Спробуйте менший файл.", error);
        } finally {
            if (!complete) {
                deleteDirectory(directory);
            }
        }
    }

    public JSONObject json() throws JSONException {
        JSONArray pageArray = new JSONArray();
        for (PageInfo page : pages) {
            pageArray.put(new JSONObject()
                    .put("width", page.width)
                    .put("height", page.height)
                    .put("bytes", page.bytes));
        }
        return new JSONObject()
                .put("id", id)
                .put("name", name)
                .put("pages", pageArray)
                .put("totalBytes", totalBytes);
    }

    public File slide(int zeroBasedIndex) {
        if (zeroBasedIndex < 0 || zeroBasedIndex >= pages.size()) {
            throw new IndexOutOfBoundsException("Некоректний номер сторінки: " + zeroBasedIndex);
        }
        return slideFile(directory, zeroBasedIndex);
    }

    @Override
    public void close() {
        deleteDirectory(directory);
    }

    public static void deleteDirectory(File directory) {
        if (directory == null) {
            return;
        }
        if (!Files.isSymbolicLink(directory.toPath()) && directory.isDirectory()) {
            File[] children = directory.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteDirectory(child);
                }
            }
        }
        directory.delete();
    }

    private static File slideFile(File directory, int pageIndex) {
        return new File(directory, "slide-" + pageIndex + ".jpg");
    }

    private static String displayName(Context context, Uri source) {
        try (Cursor cursor = context.getContentResolver().query(source,
                new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (column >= 0) {
                    String name = cursor.getString(column);
                    if (name != null && !name.trim().isEmpty()) {
                        return name.substring(0, Math.min(name.length(), 200));
                    }
                }
            }
        } catch (RuntimeException exception) {
            return "Презентація.pdf";
        }
        return "Презентація.pdf";
    }

    private static void copySource(Context context, Uri source, File destination) throws IOException {
        try (InputStream input = context.getContentResolver().openInputStream(source)) {
            if (input == null) {
                throw new IOException("Не вдалося відкрити вибраний PDF.");
            }
            try (FileOutputStream output = new FileOutputStream(destination)) {
                byte[] buffer = new byte[16 * 1024];
                long copied = 0;
                while (true) {
                    checkInterrupted();
                    int count = input.read(buffer);
                    checkInterrupted();
                    if (count == -1) {
                        break;
                    }
                    copied += count;
                    if (copied > MAX_PDF_BYTES) {
                        throw new IOException("PDF перевищує ліміт 40 МіБ.");
                    }
                    output.write(buffer, 0, count);
                }
            }
        }
    }

    private static void verifyHeader(File input) throws IOException {
        byte[] expected = {'%', 'P', 'D', 'F', '-'};
        try (FileInputStream stream = new FileInputStream(input)) {
            for (byte value : expected) {
                checkInterrupted();
                if (stream.read() != value) {
                    throw new IOException("Вибраний файл не є PDF: відсутній заголовок %PDF-.");
                }
            }
        }
    }

    private static PdfRenderer openRenderer(ParcelFileDescriptor descriptor) throws IOException {
        try {
            return new PdfRenderer(descriptor);
        } catch (SecurityException exception) {
            throw new IOException("PDF захищений паролем або забороняє перегляд. Виберіть PDF без пароля.",
                    exception);
        } catch (IOException | IllegalArgumentException exception) {
            throw new IOException("PDF пошкоджений або має непідтримуваний формат.", exception);
        }
    }

    private static void checkInterrupted() throws InterruptedIOException {
        if (Thread.currentThread().isInterrupted()) {
            throw new InterruptedIOException("Обробку PDF скасовано.");
        }
    }
}
