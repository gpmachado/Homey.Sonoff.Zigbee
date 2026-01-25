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


// TurboMode constants 
const TURBO_MODE_VALUES = {
    OFF: 9,   // 0x09 - normal radio power
    ON: 20    // 0x14 - turbo radio power (extended range)
};

// Inching protocol constants
const INCHING_PROTOCOL = {
    CMD: 0x01,              // Command identifier
    SUBCMD_INCHING: 0x17,   // Inching sub-command
    PAYLOAD_LENGTH: 0x07,   // Length of payload data
    SEQ_NUM: 0x80,          // Sequence number
    FLAG_ENABLE: 0x80,      // Bit 7: Enable inching
    FLAG_MODE_ON: 0x01      // Bit 0: Mode (1=ON→OFF, 0=OFF→ON)
};

class SonoffZBMINIR2 extends SonoffBase {

    _verifyTimeout = null;

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
                minInterval: 1,      // Minimum 1 second between reports
                maxInterval: 3600,   // Maximum 1 hour
                minChange: 1
            }
        ]).catch(err => this.error(`Failed to configure attribute reporting:`, err));

        // Bind toggle command trigger for detached relay mode
        this.zclNode.endpoints[1].bind(CLUSTER.ON_OFF.NAME, new MyOnOffBoundCluster(this));
        
        // ========================================
        // HANDLE cmdId 11 (0x0B) - protocolDataResponse
        // ========================================
        // Use event listener for manufacturer-specific command
        // This is the CORRECT way to handle manufacturer-specific server-to-client commands!
        
        const sonoffCluster = this.zclNode.endpoints[1].clusters.SonoffCluster;
        
        if (!sonoffCluster) {
            this.error(`SonoffCluster not available on this device`);
            return;
        }
        
        // CRITICAL: Set manufacturerId permanently on cluster instance
        // Required for zigbee-clusters to recognize manufacturer-specific commands
        sonoffCluster.manufacturerId = 0x1286;
        
        // Register event listener for protocolDataResponse (cmdId 11)
        sonoffCluster.on('protocolDataResponse', (payload) => {
            this.log(`ZBMINIR2: Received protocolDataResponse (cmdId 11)`);
            
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
                            this.log(`  Inching command executed successfully`);
                        } else if (status === 0x81) {
                            this.log(`  Inching rejected by firmware (check: detach_mode=false, compatible switch_mode, relay state)`);
                        } else {
                            this.error(`  Inching failed with status=0x${status !== null ? status.toString(16) : 'unknown'}`);
                        }
                        break;
                    default:
                        this.log(`  Unknown command type: 0x${cmdType.toString(16)}`);
                }
            } else {
                this.log(`  Received protocolDataResponse but no data`);
            }
        });
        
        this.log(`ZBMINIR2: protocolDataResponse event listener registered`);
        
        // ========================================
        // END cmdId 11 handler
        // ========================================
        
        // Read initial attributes from device
        this.checkAttributes();
        
        // Apply initial inching settings if defined
        const settings = this.getSettings();
        if (settings && settings.inching_enabled !== undefined) {
            try {
                const inchingTime = settings.inching_time || 1;
                const inchingMode = settings.inching_mode || 'on';
                
                await this.setInching(
                    settings.inching_enabled,
                    inchingTime,
                    inchingMode
                );
                this.log(`Initial inching settings applied`);
            } catch (error) {
                this.error(`Failed to apply initial inching settings:`, error);
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
        this.log(`Settings changed:`, changedKeys);

        // Cache cluster references
        const onOffCluster = this.zclNode.endpoints[1].clusters.onOff;

        // Handle power-on behavior (OnOff cluster - standard Zigbee, no manufacturer code needed)
        if (changedKeys.includes("power_on_behavior")) {
            try {
                await onOffCluster.writeAttributes({
                    powerOnBehavior: newSettings.power_on_behavior
                });
                this.log(`Power-on behavior updated successfully`);
                
                // Verify the value was written correctly
                this._verifyTimeout = setTimeout(async () => {
                    this._verifyTimeout = null;
                    try {
                        const result = await onOffCluster.readAttributes('powerOnBehavior');
                        this.log(`Power-on behavior verified:`, result.powerOnBehavior);
                    } catch (err) {
                        this.error(`Failed to verify power-on behavior:`, err);
                    }
                }, 1000);
            } catch (error) {
                this.error(`Error updating power_on_behavior:`, error);
                throw new Error(`Failed to update power-on behavior: ${error.message}`);
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
                this.error(`Error updating TurboMode:`, error);
                throw new Error(`Failed to update Turbo Mode: ${error.message}`);
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
                this.error(`Error updating switch_mode:`, error);
                throw new Error(`Failed to update switch mode: ${error.message}`);
            }
        }

        // Handle other SonoffCluster attributes
        const otherSonoffKeys = changedKeys.filter(key =>
            SonoffCluster.ZBMINIR2_ATTRIBUTES.includes(key) &&
            key !== 'TurboMode' &&
            key !== 'switch_mode'
        );
        
        if (otherSonoffKeys.length > 0) {
            try {
                this.log(`Updating other SonoffCluster attributes:`, otherSonoffKeys);
                await this.writeAttributes(SonoffCluster, newSettings, otherSonoffKeys);
                this.log(`SonoffCluster attributes updated successfully`);
            } catch (error) {
                this.error(`Error updating SonoffCluster attributes:`, error);
                throw new Error(`Failed to update device settings: ${error.message}`);
            }
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
                this.log(`Inching settings updated successfully`);
            } catch (error) {
                this.error(`Error updating inching settings:`, error);
                throw new Error(`Failed to update inching settings: ${error.message}`);
            }
        }
    }

    /**
     * Set inching (auto-off/on) configuration
     * 
     * Inching mode automatically toggles the relay after a specified time.
     * Useful for momentary control (e.g., door opener, garage door).
     * 
     * @param {boolean} enabled - Enable/disable inching mode
     * @param {number} time - Time in seconds (0.5-32767.5, converted to 0.5s units)
     * @param {'on'|'off'} mode - 'on': ON→OFF after time, 'off': OFF→ON after time
     * @throws {Error} If SonoffCluster is not available
     * @throws {TypeError} If parameters are invalid
     * @returns {Promise<void>}
     */
    async setInching(enabled = false, time = 1, mode = 'on') {
        // Validate inputs
        if (typeof enabled !== 'boolean') {
            throw new TypeError(`enabled must be boolean, got ${typeof enabled}`);
        }
        if (typeof time !== 'number' || time < 0 || time > 32767.5) {
            throw new RangeError(`time must be between 0 and 32767.5 seconds, got ${time}`);
        }
        if (!['on', 'off'].includes(mode)) {
            throw new TypeError(`mode must be "on" or "off", got "${mode}"`);
        }
        
        try {
            // Convert time from seconds to 0.5 second units
            const msTime = Math.round(time * 1000);
            const rawTimeUnits = Math.round(msTime / 500);
            const tmpTime = Math.min(Math.max(rawTimeUnits, 1), 0xffff);
            
            // Build payload according to Zigbee2MQTT format
            const payloadValue = [];
            payloadValue[0] = INCHING_PROTOCOL.CMD;
            payloadValue[1] = INCHING_PROTOCOL.SUBCMD_INCHING;
            payloadValue[2] = INCHING_PROTOCOL.PAYLOAD_LENGTH;
            payloadValue[3] = INCHING_PROTOCOL.SEQ_NUM;
            
            // Byte 4: Mode flags
            payloadValue[4] = 0x00;
            if (enabled) {
                payloadValue[4] |= INCHING_PROTOCOL.FLAG_ENABLE;
            }
            if (mode === 'on') {
                payloadValue[4] |= INCHING_PROTOCOL.FLAG_MODE_ON;
            }
            
            payloadValue[5] = 0x00;                      // Channel
            payloadValue[6] = tmpTime & 0xff;            // Time low byte
            payloadValue[7] = (tmpTime >> 8) & 0xff;     // Time high byte
            payloadValue[8] = 0x00;                      // Reserve
            payloadValue[9] = 0x00;                      // Reserve
            
            // XOR checksum
            const checksumLength = payloadValue[2] + 3;
            payloadValue[10] = this._calculateChecksum(payloadValue, checksumLength);
            
            this.log(`Sending inching command:`, {
                enabled,
                mode,
                time_seconds: time,
                payload_hex: Buffer.from(payloadValue).toString('hex')
            });
            
            const cluster = this.zclNode.endpoints[1].clusters['SonoffCluster'];
            if (!cluster) {
                throw new Error(`SonoffCluster not available - cannot set inching`);
            }
            
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
            
            this.log(`Inching command sent successfully`);
            
        } catch (error) {
            this.error(`Failed to set inching:`, error);
            throw error;
        }
    }

    /**
     * Calculate XOR checksum for protocol data payload
     * @param {number[]} payload - Payload array
     * @param {number} length - Number of bytes to checksum
     * @returns {number} XOR checksum value
     */
    _calculateChecksum(payload, length) {
        let checksum = 0x00;
        for (let i = 0; i < length; i++) {
            checksum ^= payload[i];
        }
        return checksum;
    }

    /**
     * Read and initialize device attributes
     */
    async checkAttributes() {
        
        // Read power-on behavior from OnOff cluster
        this.readAttribute(CLUSTER.ON_OFF, ['powerOnBehavior'], (data) => {
            if (data && data.powerOnBehavior !== undefined) {
                this.log(`Read powerOnBehavior:`, data.powerOnBehavior);
                this.setSettings({ power_on_behavior: data.powerOnBehavior })
                    .catch(err => this.error(`Failed to set powerOnBehavior setting:`, err));
            } else {
                this.log(`powerOnBehavior not available in response`);
            }
        });
        
        // Read SonoffCluster attributes
        this.readAttribute(SonoffCluster, SonoffCluster.ZBMINIR2_ATTRIBUTES, (data) => {
            this.log(`Read SonoffCluster attributes:`, data);
            
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
                .then(() => this.log(`Device settings initialized successfully`))
                .catch(err => this.error(`Error initializing settings:`, err));
        });
    }

    /**
     * onDeleted is called when the user deleted the device.
     */
    async onDeleted() {
        this.log(`ZBMINIR2 switch removed`);
        
        // Clean up event listener
        const sonoffCluster = this.zclNode?.endpoints?.[1]?.clusters?.SonoffCluster;
        if (sonoffCluster) {
            sonoffCluster.removeAllListeners('protocolDataResponse');
        }
        
        // Clean up timeouts
        if (this._verifyTimeout) {
            clearTimeout(this._verifyTimeout);
            this._verifyTimeout = null;
        }
        
        // Call parent cleanup
        await super.onDeleted();
    }

}

module.exports = SonoffZBMINIR2;
