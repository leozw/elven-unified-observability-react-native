# Version-qualified access to RN's effective client and per-request TLS/proxy hook.
-keepclassmembers class com.facebook.react.modules.network.NetworkingModule {
    okhttp3.OkHttpClient mClient;
    okhttp3.OkHttpClient client;
    com.facebook.react.modules.network.CustomClientBuilder customClientBuilder;
}
