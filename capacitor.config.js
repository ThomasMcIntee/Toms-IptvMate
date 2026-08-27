const config = {
  appId: "tv.toms.iptvmate",
  appName: "Toms IPTVmate",
  webDir: "dist",
  bundledWebRuntime: false,
  server: {
    androidScheme: "http",
    hostname: "app",
    allowNavigation: ["*"]
  }
};

module.exports = config;
