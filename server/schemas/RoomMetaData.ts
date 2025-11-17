import mongoose, { Schema, Document } from 'mongoose';

// Base interface for data operations (insert, update)
export interface RoomMetaDataBase {
	totalEventsReceived: Number;
	inflightAwaitingProcessingCount: Number;
	persistedAwaitingSnapshotCount: Number;
	snapshottedAwaitingPersistCount: Number;
	completedCount: Number;
	snapshotCount: Number;
	lastSnapshotAt: Number;
	createdAt: Number;
	lastEventAt: Number;
	lastPersistedAt: Number;
	version: Number;
	lastErrorAt: Number;
	roomId: string;
	lastErrorType?: string;
	lastErrorMessage?: string;
	consecutiveErrors: Number;
	snapshotTotalEventCount: Number;
}

// Document interface that extends both base and Document
export interface RoomMetaData extends RoomMetaDataBase, Document {}

const RoomMetaDataSchema = new Schema<RoomMetaData>(
	{
		// Core counters
		totalEventsReceived: { type: Number, required: true },
		inflightAwaitingProcessingCount: { type: Number, required: true },
		persistedAwaitingSnapshotCount: { type: Number, required: true },
		snapshottedAwaitingPersistCount: { type: Number, required: true },
		completedCount: { type: Number, required: true },

		// Snapshot tracking
		snapshotCount: { type: Number, required: true }, // number of snapshots taken
		snapshotTotalEventCount: { type: Number, required: true }, // total events in all snapshots

		// Timestamps
		createdAt: { type: Number, required: true },
		lastEventAt: { type: Number, required: true },
		lastPersistedAt: { type: Number, required: true },
		lastSnapshotAt: { type: Number, required: true },

		// Error tracking
		consecutiveErrors: { type: Number, required: true, default: 0 }, // For circuit breaker logic
		lastErrorAt: { type: Number, required: true, default: 0 },
		lastErrorType: { type: String, required: false },
		lastErrorMessage: { type: String, required: false },

		// Identifiers
		roomId: { type: String, required: true },
		version: { type: Number, required: true },
	},
	{ timestamps: true }
);

export default mongoose.model<RoomMetaData>('RoomMetaData', RoomMetaDataSchema);
