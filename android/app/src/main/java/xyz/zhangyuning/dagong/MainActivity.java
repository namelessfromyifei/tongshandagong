package xyz.zhangyuning.dagong;

import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if(!hasFocus) return;
        // 下拉通知栏/快捷设置收起后，部分机型会重新露出状态栏，WebView 顶部还会残留旧画面。
        // 重新获得焦点时再隐藏一次状态栏，并让 WebView 重绘一遍。
        try {
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(
                    getWindow(), getWindow().getDecorView());
            if(c != null) {
                c.hide(WindowInsetsCompat.Type.statusBars());
                c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
            WebView wv = getBridge() != null ? getBridge().getWebView() : null;
            if(wv != null) wv.invalidate();
        } catch(Exception ignored) {}
    }
}
