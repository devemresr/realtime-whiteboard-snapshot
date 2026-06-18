export interface BatchProcessingConfig {
	strokeCountThreshold: number;
	timeoutMs: number;
	consumerGroup: string;
}

export interface BatchProcessingInput {
	strokeCountThreshold?: number;
	timeoutMs?: number;
	consumerGroup: string;
}

export interface Stroke {
	x: number;
	y: number;
	timestamp: number;
}

export interface LockResult {
	lockKey: string;
	lockValue: string;
}

export interface RoomDataBase {
	roomId: string;
	strokes: Stroke[];
	strokeId: string;
	packageSequenceNumber: number;
	isLastPackage?: boolean;
	strokeSequenceNumber: number;
	packageId: string;
	redisMessageId: string;
}

export interface TransformedRoomData extends RoomDataBase {
	isPersisted: boolean;
}

export interface CleanupResult {
	successfullCleanupIds: string[];

	newInflightAwaitingProcessingCount: number;
	newPersistedAwaitingSnapshotCount: number;
	newCompletedCount: number;
	newSnapshottedAwaitingPersistCount: number;
	newSnapshotTotalEventCount: number;

	timestamp: number;

	removedFromInflightTotal: number;
	removedFromPersistedTotal: number;
	addedToSnapshottedTotal: number;
	completedProcessingAdded: number;
}

export type CleanupResultTuple = [
	string[], // successfullCleanupIds

	number, // newInflightAwaitingProcessingCount
	number, // newPersistedAwaitingSnapshotCount
	number, // newCompletedCount
	number, // newSnapshottedAwaitingPersistCount
	number, // newSnapshotTotalEventCount

	number, // timestamp

	number, // removedFromInflightTotal
	number, // removedFromPersistedTotal
	number, // addedToSnapshottedTotal
	number, // completedProcessingAdded
];
