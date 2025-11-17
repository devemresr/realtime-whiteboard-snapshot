import stableHash from '../../utils/stableHash';
import HeartbeatService from '../heartBeatService';

export class RoomResponsibilityService {
	private heartBeatService: HeartbeatService;
	private serverId: string;
	private cycleDurationMs: number;

	constructor(
		heartBeatService: HeartbeatService,
		serverId: string,
		cycleDurationMs = 10 * 1000
	) {
		this.heartBeatService = heartBeatService;
		this.serverId = serverId;
		this.cycleDurationMs = cycleDurationMs;
	}

	async isResponsibleFor(roomId: string): Promise<boolean> {
		try {
			const { activeServers } = await this.heartBeatService.getActiveServers();

			if (activeServers.length === 0) return false;

			const myServerIndex = activeServers.findIndex(
				(server: any) => server.id === this.serverId
			);

			if (myServerIndex === -1) {
				return false;
			}

			const cycleNumber = Math.floor(Date.now() / this.cycleDurationMs);
			const responsibleIndex =
				stableHash(`${roomId}-${cycleNumber}`) % activeServers.length;

			return responsibleIndex === myServerIndex;
		} catch (error) {
			console.error('Error determining server responsibility:', error);
			return false;
		}
	}
}
