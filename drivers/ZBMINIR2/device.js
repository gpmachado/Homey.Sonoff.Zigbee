'use strict';

const { ZigBeeDevice } = require("homey-zigbeedriver");

const SonoffOnOffCluster = require("../../lib/SonoffOnOffCluster");
const { Cluster, CLUSTER, BoundCluster } = require('zigbee-clusters');
Cluster.addCluster(SonoffOnOffCluster);

const SonoffCluster = require("../../lib/SonoffCluster");
Cluster.addCluster(SonoffCluster);

const SonoffBase = require('../sonoffbase');

/**
 * Bound OnOff cluster used when Detach Relay mode is enabled.
 *
 * In Detach Relay mode, the physical button does NOT change the relay state
 * and does NOT send onOff attribute reports.
 * Instead, the device sends ZCL commands (e.g. "toggle") which are interpreted
 * as button events and mapped to Homey Flow triggers.
 */
class MyOnOffBoundCluster extends BoundCluster {
    constructor(node) {
        super();
        this.node = node;
        this._click = node.homey.flow.getDeviceTriggerCard("ZBMINIR2:click");
    }
    
    /**
     * Handle toggle command from physical switch
     * In detached mode, physical switch sends toggle commands without changing relay state
     */
    toggle() {
        this.node.log('Detach Mode: Physical switch toggled, triggering Flow Card');
        this._click.trigger(this.node, {}, {})
            .catch(err => this.node.error('Failed to trigger click flow:', err));
    }
}


// SonoffCluster attributes list
const SonoffClusterAttributes = [
    'TurboMode',
    'network_led',
    'power_on_delay_state',
    'power_on_delay_time',
    'switch_mode',
    'detach_mode'
];

// TurboMode constants (radioPower attribute in Zigbee2MQTT)
const TURBO_MODE_VALUES = {
    OFF: 9,   // 0x09 - normal radio power
    ON: 20    // 0x14 - turbo radio power (extended range)
};

class SonoffZBMINIR2 extends SonoffBase {

    /**
     * onNodeInit is called when the device is initialized.
     */
    async onNodeInit({ zclNode }) {
        
        super.onNodeInit({zclNode});

        if (this.hasCapability('onoff')) {
            this.registerCapability('onoff', CLUSTER.ON_OFF);
        }

        // Configure attribute reporting for on/off state
        this.configureAttributeReporting([
            {
                endpointId: 1,
                cluster: CLUSTER.ON_OFF,
                attributeName: 'onOff',
                minInterval: 0,
                maxInterval: 3600
            }
        ]).catch(this.error);

        // Bind toggle command trigger for detached relay mode
        this.zclNode.endpoints[1].bind(CLUSTER.ON_OFF.NAME, new MyOnOffBoundCluster(this));
        
        // ========================================
        // HANDLE cmdId 11 (0x0B) - protocolDataResponse
        // ========================================
        // Use event listener for manufacturer-specific command
        // This is the CORRECT way to handle manufacturer-specific server-to-client commands!
        
        const sonoffCluster = this.zclNode.endpoints[1].clusters.SonoffCluster;
        
        // CRITICAL: Set manufacturerId permanently on cluster instance
        // Required for zigbee-clusters to recognize manufacturer-specific commands
        sonoffCluster.manufacturerId = 0x1286;
        
        // Register event listener for protocolDataResponse (cmdId 11)
        sonoffCluster.on('protocolDataResponse', (payload) => {
            this.log('ZBMINIR2: Received protocolDataResponse (cmdId 11)');
            
            if (payload && payload.data && Buffer.isBuffer(payload.data)) {
                const buffer = payload.data;
                const cmdType = buffer[0];
                const status = buffer.length > 1 ? buffer[1] : null;
                
                this.log(`  Command type: 0x${cmdType.toString(16)}`);
                this.log(`  Status: 0x${status !== null ? status.toString(16) : 'N/A'} (${status === 0x00 ? 'SUCCESS' : 'FAILURE'})`);
                this.log(`  Raw data: ${buffer.toString('hex')}`);
                
                // Parse based on command type
                switch (cmdType) {
                    case 0x01:
                        // Response to protocolData command (inching, etc)
                        if (status === 0x00) {
                            this.log('  Inching command executed successfully');
                        } else if (status === 0x81) {
                            this.log('  Inching rejected by firmware (check: detach_mode=false, compatible switch_mode, relay state)');
                        } else {
                            this.error(`  Inching failed with status=0x${status !== null ? status.toString(16) : 'unknown'}`);
                        }
                        break;
                    default:
                        this.log(`  Unknown command type: 0x${cmdType.toString(16)}`);
                }
            } else {
                this.log('  Received protocolDataResponse but no data');
            }
        });
        
        this.log('ZBMINIR2: protocolDataResponse event listener registered');
        
        // ========================================
        // END cmdId 11 handler
        // ========================================
        
        // Read initial attributes from device
        this.checkAttributes();
        
        // Apply initial inching settings if defined
        const settings = this.getSettings();
        if (settings.inching_enabled !== undefined) {
            try {
                await this.setInching(
                    settings.inching_enabled,
                    settings.inching_time || 1000,
                    settings.inching_mode || 'on'
                );
                this.log('Initial inching settings applied');
            } catch (error) {
                this.error('Failed to apply initial inching settings:', error);
            }
        }
    }

    /**
     * Convert TurboMode raw value (radioPower) to boolean
     */
    _parseTurboMode(rawValue) {
        if (rawValue === TURBO_MODE_VALUES.ON || rawValue === true || rawValue === 1) {
            return true;
        }
        return false;
    }

    /**
     * Convert boolean to TurboMode raw value (radioPower)
     */
    _formatTurboMode(enabled) {
        return enabled ? TURBO_MODE_VALUES.ON : TURBO_MODE_VALUES.OFF;
    }

    /**
     * Convert switch_mode string to number (for writing to device)
     */
    _formatSwitchMode(mode) {
        return parseInt(mode, 10);
    }

    /**
     * Convert switch_mode number to string (for reading from device)
     */
    _parseSwitchMode(mode) {
        return String(mode);
    }

    /**
     * onSettings is called when the user updates the device's settings.
     */
    async onSettings({ oldSettings, newSettings, changedKeys }) {
        this.log('Settings changed:', changedKeys);

        // Handle power-on behavior (OnOff cluster - standard Zigbee, no manufacturer code needed)
        if (changedKeys.includes("power_on_behavior")) {
            try {
                await this.zclNode.endpoints[1].clusters.onOff.writeAttributes({
                    powerOnBehavior: newSettings.power_on_behavior
                });
                this.log('Power-on behavior updated successfully');
                
                // Verify the value was written correctly
                setTimeout(async () => {
                    try {
                        const result = await this.zclNode.endpoints[1].clusters.onOff.readAttributes('powerOnBehavior');
                        this.log('Power-on behavior verification:', result);
                    } catch (err) {
                        this.error('Failed to verify power-on behavior:', err);
                    }
                }, 1000);
            } catch (error) {
                this.error("Error updating power_on_behavior:", error);
                throw new Error('Failed to update power-on behavior');
            }
        }

        // Handle TurboMode separately - convert boolean to int16 before writing
        if (changedKeys.includes('TurboMode')) {
            try {
                const rawValue = this._formatTurboMode(newSettings.TurboMode);
                this.log(`Writing TurboMode: ${newSettings.TurboMode} → raw value: 0x${rawValue.toString(16)} (${rawValue})`);
                
                await this.writeAttribute(SonoffCluster, 'TurboMode', rawValue);
                
                this.log(`TurboMode updated successfully to ${newSettings.TurboMode}`);
            } catch (error) {
                this.error("Error updating TurboMode:", error);
                throw new Error('Failed to update Turbo Mode');
            }
        }

        // Handle switch_mode separately - convert string to uint8 before writing
        if (changedKeys.includes('switch_mode')) {
            try {
                const rawValue = this._formatSwitchMode(newSettings.switch_mode);
                this.log(`Writing switch_mode: "${newSettings.switch_mode}" → raw value: ${rawValue}`);
                
                await this.writeAttribute(SonoffCluster, 'switch_mode', rawValue);
                
                this.log(`switch_mode updated successfully to ${newSettings.switch_mode}`);
            } catch (error) {
                this.error("Error updating switch_mode:", error);
                throw new Error('Failed to update switch mode');
            }
        }

        // Handle other SonoffCluster attributes
        const otherSonoffKeys = changedKeys.filter(key =>
            SonoffClusterAttributes.includes(key) &&
            key !== 'TurboMode' &&
            key !== 'switch_mode'
        );
        
        if (otherSonoffKeys.length > 0) {
            this.log('Updating other SonoffCluster attributes:', otherSonoffKeys);
            this.writeAttributes(SonoffCluster, newSettings, otherSonoffKeys).catch(this.error);
        }

        // Handle inching settings changes
        const inchingKeys = ['inching_enabled', 'inching_mode', 'inching_time'];
        const inchingChanged = changedKeys.some(key => inchingKeys.includes(key));
        
        if (inchingChanged) {
            try {
                await this.setInching(
                    newSettings.inching_enabled,
                    newSettings.inching_time,
                    newSettings.inching_mode
                );
                this.log('Inching settings updated successfully');
            } catch (error) {
                this.error('Error updating inching settings:', error);
                throw new Error('Failed to update inching settings');
            }
        }
    }

    /**
     * Set inching (auto-off/on) configuration
     */
    async setInching(enabled = false, time = 1, mode = 'on') {
        try {
            // Convert time from seconds to 0.5 second units
            const msTime = Math.round(time * 1000);
            const rawTimeUnits = Math.round(msTime / 500);
            const tmpTime = Math.min(Math.max(rawTimeUnits, 1), 0xffff);
            
            // Build payload according to Zigbee2MQTT format
            const payloadValue = [];
            payloadValue[0] = 0x01;  // Cmd
            payloadValue[1] = 0x17;  // SubCmd - INCHING
            payloadValue[2] = 0x07;  // Length
            payloadValue[3] = 0x80;  // SeqNum
            
            // Byte 4: Mode flags
            payloadValue[4] = 0x00;
            if (enabled) {
                payloadValue[4] |= 0x80;  // Bit 7: Enable
            }
            if (mode === 'on') {
                payloadValue[4] |= 0x01;  // Bit 0: Mode (1=ON→OFF, 0=OFF→ON)
            }
            
            payloadValue[5] = 0x00;  // Channel
            payloadValue[6] = tmpTime & 0xff;         // Time low byte
            payloadValue[7] = (tmpTime >> 8) & 0xff;  // Time high byte
            payloadValue[8] = 0x00;  // Reserve
            payloadValue[9] = 0x00;  // Reserve
            
            // XOR checksum
            payloadValue[10] = 0x00;
            for (let i = 0; i < payloadValue[2] + 3; i++) {
                payloadValue[10] ^= payloadValue[i];
            }
            
            this.log('Sending inching command:', {
                enabled,
                mode,
                time_seconds: time,
                payload_hex: Buffer.from(payloadValue).toString('hex')
            });
            
            const cluster = this.zclNode.endpoints[1].clusters['SonoffCluster'];
            const payloadBuffer = Buffer.from(payloadValue);

            await cluster.protocolData(
                { data: payloadBuffer },
                { 
                    disableDefaultResponse: true, 
                    waitForResponse: false,
                    manufacturerSpecific: true,
                    manufacturerId: 0x1286
                }
            );
            
            this.log('Inching command sent successfully');
            
        } catch (error) {
            this.error('Failed to set inching:', error);
            throw error;
        }
    }

    /**
     * Read and initialize device attributes
     */
    async checkAttributes() {
        
        // Read power-on behavior from OnOff cluster
        this.readAttribute(CLUSTER.ON_OFF, ['powerOnBehavior'], (data) => {
            this.log('Read powerOnBehavior:', data.powerOnBehavior);
            this.setSettings({ power_on_behavior: data.powerOnBehavior }).catch(this.error);
        });
        
        // Read SonoffCluster attributes
        this.readAttribute(SonoffCluster, SonoffClusterAttributes, (data) => {
            this.log('Read SonoffCluster attributes:', data);
            
            // Process and convert data
            const settingsData = { ...data };
            
            // Convert TurboMode from int16 to boolean
            if (settingsData.TurboMode !== undefined) {
                const rawValue = settingsData.TurboMode;
                const boolValue = this._parseTurboMode(rawValue);
                
                this.log(`TurboMode from device: raw=0x${rawValue.toString(16)} (${rawValue}) → boolean=${boolValue}`);
                settingsData.TurboMode = boolValue;
            }

            // Convert switch_mode from uint8 to string
            if (settingsData.switch_mode !== undefined) {
                const rawValue = settingsData.switch_mode;
                const stringValue = this._parseSwitchMode(rawValue);
                
                this.log(`switch_mode from device: raw=${rawValue} → string="${stringValue}"`);
                settingsData.switch_mode = stringValue;
            }
            
            // Apply settings to Homey UI
            this.setSettings(settingsData)
                .then(() => this.log('Device settings initialized successfully'))
                .catch(err => this.error('Error initializing settings:', err));
        });
    }

    /**
     * onDeleted is called when the user deleted the device.
     */
    async onDeleted() {
        this.log("ZBMINIR2 switch removed");
    }

}

module.exports = SonoffZBMINIR2;
