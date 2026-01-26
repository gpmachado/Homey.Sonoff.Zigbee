const { OnOffSwitchCluster, ZCLDataTypes } = require('zigbee-clusters');

/**
 * Sonoff extension of OnOffSwitchCluster
 * Adds custom switchType and switchAction attributes
 */
class SonoffOnOffSwitchCluster extends OnOffSwitchCluster {

  static get ATTRIBUTES() {
    return {
      ...super.ATTRIBUTES,
      switchType: {
          id: 0,
          type: ZCLDataTypes.enum8({
            toggle: 0,      // Toggle mode (press to switch state)
            momentary: 1    // Momentary mode (press and hold)
          })
      },
      switchAction: {
        // Note: This attribute is currently unused in driver implementations
        // TODO: Document valid values when device behavior is confirmed
        // Potentially: on(0), off(1), toggle(2) based on Zigbee2MQTT patterns
        id: 16,
        type: ZCLDataTypes.enum8({})
    },
    };
  }

}

module.exports = SonoffOnOffSwitchCluster;
