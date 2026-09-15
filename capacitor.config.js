const config = {
  appId: "tv.toms.iptvmate",
  appName: "Tom's IPTVmate",
  webDir: "dist",
  bundledWebRuntime: false,
  server: {
    androidScheme: "http",
    hostname: "app",
    allowNavigation: ["*"]
  }
};

module.exports = config;
