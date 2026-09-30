import { Injectable, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService {
  private app: admin.app.App | null = null;

  constructor(private readonly config: ConfigService) {}

  private getApp() {
    if (this.app) return this.app;
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    const clientEmail = this.config.get<string>('FIREBASE_CLIENT_EMAIL');
    const privateKey = this.config.get<string>('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      throw new ServiceUnavailableException(
        'Firebase Admin no está configurado. Define FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL y FIREBASE_PRIVATE_KEY.',
      );
    }
    if (!admin.apps.length) {
      this.app = admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      });
    } else {
      this.app = admin.app();
    }
    return this.app;
  }

  async verifyPhoneToken(idUser: string, phone: string, idToken: string) {
    const decoded = await this.getApp().auth().verifyIdToken(idToken);
    if (decoded.phone_number !== phone) {
      throw new BadRequestException('El teléfono del token Firebase no coincide con el indicado');
    }
    return { verified: true, firebaseUid: decoded.uid, phone: decoded.phone_number, idUser };
  }
}
