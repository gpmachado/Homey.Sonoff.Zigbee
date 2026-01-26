'use strict';

const { ZigBeeDevice } = require("homey-zigbeedriver");
const { CLUSTER } = require('zigbee-clusters');

/**
 * Sonoff BASICZBR3 - Basic Zigbee Switch
 * 
 * Simple on/off switch without advanced Sonoff features.
 * Does not support custom Sonoff clusters (0xFC11) or manufacturer-specific attributes.
 */
class SonoffBASICZBR3 extends ZigBeeDevice {

    /**
     * onNodeInit is called when the device is initialized.
     */
    async onNodeInit({ zclNode }) {
        this.log(`BASICZBR3: Device initialized`);
        this.printNode();

        // Register on/off capability
        if (this.hasCapability('onoff')) {
            this.registerCapability('onoff', CLUSTER.ON_OFF);
        }

        // Configure attribute reporting for on/off state
        this.configureAttributeReporting([
            {
                endpointId: 1,
                cluster: CLUSTER.ON_OFF,
                attributeName: 'onOff',
                minInterval: 1,      // Minimum 1 second between reports
                maxInterval: 3600,   // Maximum 1 hour (report at least once/hour)
                minChange: 1         // Report on any state change
            }
        ]).catch(err => this.error(`Failed to configure attribute reporting:`, err));
    }

    /**
     * onDeleted is called when the user deleted the device.
     */
    async onDeleted() {
        this.log(`BASICZBR3: Switch removed`);
    }

}

module.exports = SonoffBASICZBR3;
