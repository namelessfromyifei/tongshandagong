package xyz.zhangyuning.dagong;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * 拉起系统 APK 安装器（App 内更新用）。
 * APK 由 @capacitor/filesystem 下载到应用缓存目录，这里通过 FileProvider 授权给系统安装器。
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("缺少 APK 路径");
            return;
        }
        String plain = path.startsWith("file://") ? Uri.parse(path).getPath() : path;
        if (plain == null) {
            call.reject("APK 路径无效");
            return;
        }
        File file;
        try {
            file = new File(plain).getCanonicalFile();
            // 只允许安装应用缓存目录内的文件
            File cacheRoot = getContext().getCacheDir().getCanonicalFile();
            if (!file.getPath().startsWith(cacheRoot.getPath() + File.separator)) {
                call.reject("APK 不在应用缓存目录");
                return;
            }
        } catch (Exception e) {
            call.reject("APK 路径无效");
            return;
        }
        if (!file.exists()) {
            call.reject("APK 文件不存在");
            return;
        }

        // Android 8+：需要用户允许「安装未知应用」，先跳系统设置页
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !getContext().getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(s);
            } catch (Exception ignored) {
            }
            call.reject("请允许安装未知应用", "NEED_PERMISSION");
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(getContext(),
                    getContext().getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("拉起安装器失败：" + e.getMessage());
        }
    }
}
