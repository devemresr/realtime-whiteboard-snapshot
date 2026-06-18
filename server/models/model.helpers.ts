import { FlattenMaps, Types } from 'mongoose';

// FlattenMaps is for cases when the document has a nested value
export type LeanDocument<T> = FlattenMaps<T> & {
	_id: Types.ObjectId;
	createdAt?: Date;
	updatedAt?: Date;
};
