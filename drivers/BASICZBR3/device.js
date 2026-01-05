'use strict';

const { ZigBeeDevice } = require("homey-zigbeedriver");
const { CLUSTER } = require('zigbee-clusters');

class SonoffBASICZBR3 extends ZigBeeDevice {

  /**
   * onNodeInit is called when the device is initialized.
   */
  async onNodeInit({ zclNode }) {
    this.log('Device initialized');
    this.printNode();

    if (this.hasCapability('onoff')) {
      this.registerCapability('onoff', CLUSTER.ON_OFF);
    }
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log("smartswitch removed");
  }

}

module.exports = SonoffBASICZBR3;