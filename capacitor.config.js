const config = {
  appId: "tv.toms.iptvmate",
  appName: "Toms IPTVmate",
  webDir: "dist",
  bundledWebRuntime: false,
  server: {
    androidScheme: "http",
    hostname: "localhost",
    allowNavigation: ["*"]
  }
};

module.exports = config;
