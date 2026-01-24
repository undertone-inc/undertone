const { withAndroidManifest } = require('@expo/config-plugins');

// RevenueCat recommends Android launchMode "standard" or "singleTop"
// so purchase flows that background the app can resume correctly.
module.exports = function withRcLaunchmode(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const app = manifest?.manifest?.application?.[0];
    if (!app) return config;

    const activities = app.activity ?? [];
    const mainActivity = activities.find((a) => {
      const name = a?.$?.['android:name'];
      return typeof name === 'string' && name.includes('MainActivity');
    });

    if (mainActivity?.$) {
      mainActivity.$['android:launchMode'] = 'singleTop';
    }

    return config;
  });
};
